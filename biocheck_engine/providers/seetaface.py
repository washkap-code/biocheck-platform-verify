"""Controlled SeetaFace6 sidecar adapter.

SeetaFace6 remains isolated in a private inference service. This prevents native
model libraries and model files from entering the public API process and makes
model replacement a configuration/release action rather than an API rewrite.
"""
from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import numpy as np

from ..model_registry import ModelRegistry
from ..types import CaptureQuality, FaceSample, LivenessResult


@dataclass(frozen=True)
class SeetaFaceAnalysis:
    face: FaceSample
    liveness: LivenessResult


class SeetaFaceSidecar:
    """Client for BioCheck's internal SeetaFace6 service contract.

    The service must only be reachable over mTLS in production. The endpoint
    returns an embedding and passive PAD result, never stores the supplied image
    and includes the exact deployed model file hash in every response.
    """
    def __init__(self, endpoint: str, api_key: str, registry: ModelRegistry,
                 transport: Callable[[Request], bytes] | None = None) -> None:
        parsed = urlparse(endpoint)
        if parsed.scheme not in {"https", "http"}:
            raise ValueError("SeetaFace endpoint must be an HTTP(S) URL.")
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
            raise ValueError("Production SeetaFace endpoint must use HTTPS/mTLS.")
        self.endpoint = endpoint.rstrip("/") + "/v1/analyse"
        self.api_key = api_key
        self.registry = registry
        self.transport = transport or (lambda req: urlopen(req, timeout=8).read())

    def analyse(self, jpeg_bytes: bytes, challenge_id: str) -> SeetaFaceAnalysis:
        if not jpeg_bytes or len(jpeg_bytes) > 8 * 1024 * 1024:
            raise ValueError("Capture must be a JPEG below 8 MiB.")
        payload = json.dumps({
            "image_jpeg_b64": base64.b64encode(jpeg_bytes).decode(),
            "challenge_id": challenge_id,
            "retain_image": False,
        }).encode()
        request = Request(self.endpoint, data=payload, method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}",
            "X-BioCheck-Data-Classification": "biometric-sensitive",
        })
        try:
            response = json.loads(self.transport(request))
        except Exception as exc:
            raise RuntimeError("SeetaFace inference service unavailable; verification must fail closed.") from exc
        return self._parse(response)

    def _parse(self, data: dict) -> SeetaFaceAnalysis:
        required = {"embedding", "model_id", "model_sha256", "quality", "passive_pad"}
        missing = required - data.keys()
        if missing:
            raise RuntimeError(f"SeetaFace response missing required fields: {sorted(missing)}")
        self.registry.assert_allowed(data["model_id"], data["model_sha256"], "face_embedding")
        # PAD and face embedding must be independently registered; the sidecar
        # cannot substitute one model for another without this gate.
        pad = data["passive_pad"]
        self.registry.assert_allowed(pad["model_id"], pad["model_sha256"], "passive_pad")
        vector = np.asarray(data["embedding"], dtype=np.float32)
        if vector.ndim != 1 or vector.size not in {512, 1024} or not np.isfinite(vector).all():
            raise RuntimeError("SeetaFace returned an invalid embedding.")
        quality = data["quality"]
        face = FaceSample(vector, CaptureQuality(
            bool(quality["face_detected"]), float(quality["score"]), float(quality["pose_degrees"]),
            float(quality["occlusion_score"])), data["model_id"], data["model_sha256"])
        liveness = LivenessResult(bool(pad["is_live"]), float(pad["score"]), pad.get("attack_type"))
        return SeetaFaceAnalysis(face, liveness)
