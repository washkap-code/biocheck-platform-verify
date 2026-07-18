"""Controlled fingerprint sidecar adapter.

Mirrors providers/seetaface.py: the actual extractor/matcher (e.g. NIST NBIS
mindtct+bozorth3 or SourceAFIS behind a service) stays isolated in a private
inference service that BioCheck operates. The engine never links native
matcher libraries and never sees scanner SDKs — captures arrive as image
bytes, templates come back opaque, and comparison happens inside the sidecar
because minutiae matching cannot be reduced to a local vector operation.

No fingerprint sidecar exists yet (see docs/FINGERPRINT_BUILD_STATUS.md).
This client defines the wire contract it must implement. Until it exists,
fingerprint verification fails closed everywhere.
"""
from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from ..model_registry import ModelRegistry
from ..types import FingerprintPad, FingerprintQuality, FingerprintSample

MAX_CAPTURE_BYTES = 4 * 1024 * 1024
MAX_TEMPLATE_BYTES = 64 * 1024


@dataclass(frozen=True)
class FingerprintAnalysis:
    sample: FingerprintSample
    pad: FingerprintPad | None  # None when the capture path performed no PAD


@dataclass(frozen=True)
class FingerprintComparison:
    score: float  # normalised 0..1 by the sidecar's calibrated mapping
    matcher_model_id: str
    matcher_model_sha256: str


class FingerprintSidecar:
    """Client for BioCheck's internal fingerprint service contract.

    The service must only be reachable over mTLS in production. It returns an
    opaque template and quality metrics, never stores the supplied image, and
    includes the exact deployed model/algorithm file hash in every response.
    """

    #: Suffixes of orchestrator-internal service-discovery domains that are
    #: unreachable from the public internet (Fly.io private networking).
    #: Plain HTTP is permitted to these ONLY with allow_private_network=True.
    _PRIVATE_SUFFIXES = (".flycast", ".internal")

    def __init__(self, endpoint: str, api_key: str, registry: ModelRegistry,
                 transport: Callable[[Request], bytes] | None = None,
                 allow_private_network: bool = False) -> None:
        parsed = urlparse(endpoint)
        if parsed.scheme not in {"https", "http"}:
            raise ValueError("Fingerprint endpoint must be an HTTP(S) URL.")
        if parsed.scheme != "https":
            host = parsed.hostname or ""
            private = allow_private_network and host.endswith(self._PRIVATE_SUFFIXES)
            if host not in {"localhost", "127.0.0.1"} and not private:
                raise ValueError("Production fingerprint endpoint must use HTTPS/mTLS, "
                                 "or an explicitly allowed private-network hostname.")
        self.base = endpoint.rstrip("/")
        self.api_key = api_key
        self.registry = registry
        self.transport = transport or (lambda req: urlopen(req, timeout=8).read())

    def _post(self, path: str, payload: dict) -> dict:
        request = Request(self.base + path, data=json.dumps(payload).encode(), method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}",
            "X-BioCheck-Data-Classification": "biometric-sensitive",
        })
        try:
            return json.loads(self.transport(request))
        except Exception as exc:
            raise RuntimeError(
                "Fingerprint inference service unavailable; verification must fail closed.") from exc

    def analyse(self, image_bytes: bytes, challenge_id: str) -> FingerprintAnalysis:
        if not image_bytes or len(image_bytes) > MAX_CAPTURE_BYTES:
            raise ValueError("Capture must be non-empty and below 4 MiB.")
        data = self._post("/v1/analyse", {
            "image_b64": base64.b64encode(image_bytes).decode(),
            "challenge_id": challenge_id,
            "retain_image": False,
        })
        required = {"template_b64", "model_id", "model_sha256", "quality"}
        missing = required - data.keys()
        if missing:
            raise RuntimeError(f"Fingerprint response missing required fields: {sorted(missing)}")
        self.registry.assert_allowed(data["model_id"], data["model_sha256"], "fingerprint_extraction")

        template = base64.b64decode(data["template_b64"])
        if not template or len(template) > MAX_TEMPLATE_BYTES:
            raise RuntimeError("Fingerprint sidecar returned an invalid template.")
        q = data["quality"]
        quality = FingerprintQuality(
            bool(q["finger_detected"]), float(q["score"]), int(q["minutiae_count"]))

        pad: FingerprintPad | None = None
        if data.get("pad") is not None:
            p = data["pad"]
            # PAD models are independently registered — the sidecar cannot
            # substitute one model for another without this gate.
            self.registry.assert_allowed(p["model_id"], p["model_sha256"], "fingerprint_pad")
            pad = FingerprintPad(bool(p["is_live"]), float(p["score"]), p.get("attack_type"),
                                 str(p["model_id"]), str(p["model_sha256"]))
        sample = FingerprintSample(template, quality, data["model_id"], data["model_sha256"])
        return FingerprintAnalysis(sample, pad)

    def compare(self, template_a: bytes, template_b: bytes) -> FingerprintComparison:
        for template in (template_a, template_b):
            if not template or len(template) > MAX_TEMPLATE_BYTES:
                raise ValueError("Templates must be non-empty and below 64 KiB.")
        data = self._post("/v1/compare", {
            "template_a_b64": base64.b64encode(template_a).decode(),
            "template_b_b64": base64.b64encode(template_b).decode(),
        })
        required = {"score", "matcher_model_id", "matcher_model_sha256"}
        missing = required - data.keys()
        if missing:
            raise RuntimeError(f"Fingerprint compare response missing required fields: {sorted(missing)}")
        self.registry.assert_allowed(
            data["matcher_model_id"], data["matcher_model_sha256"], "fingerprint_matching")
        score = float(data["score"])
        if not (0.0 <= score <= 1.0):
            raise RuntimeError("Fingerprint sidecar returned an out-of-range score.")
        return FingerprintComparison(score, str(data["matcher_model_id"]), str(data["matcher_model_sha256"]))
