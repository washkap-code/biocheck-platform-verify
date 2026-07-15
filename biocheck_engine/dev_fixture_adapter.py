"""Deterministic dev/test fixture adapter — NEVER a real biometric provider.

Mirrors platform/src/server/verification/providers.ts's FakeProvider exactly:
the "image" bytes are actually a small JSON fixture describing the intended
outcome (e.g. {"person": "alice", "quality": 0.95}), never a real photograph.
Same person -> same embedding -> high similarity; different person -> low
similarity. This exists so the verify-core HTTP contract can be exercised
end-to-end (by tests and local development) before the real SeetaFace6
sidecar is built. It must never be reachable in production.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

import numpy as np

from .providers.fingerprint import FingerprintAnalysis, FingerprintComparison
from .providers.seetaface import SeetaFaceAnalysis
from .types import (
    CaptureQuality,
    FaceSample,
    FingerprintPad,
    FingerprintQuality,
    FingerprintSample,
    LivenessResult,
)

DEV_FACE_MODEL_ID = "dev-fixture-embedding-v1"
DEV_FACE_MODEL_SHA256 = "d" * 64
DEV_PAD_MODEL_ID = "dev-fixture-pad-v1"
DEV_PAD_MODEL_SHA256 = "c" * 64
DEV_FP_MODEL_ID = "dev-fixture-fp-extractor-v1"
DEV_FP_MODEL_SHA256 = "b" * 64
DEV_FP_PAD_MODEL_ID = "dev-fixture-fp-pad-v1"
DEV_FP_PAD_MODEL_SHA256 = "a" * 64
DEV_FP_MATCHER_MODEL_ID = "dev-fixture-fp-matcher-v1"
DEV_FP_MATCHER_MODEL_SHA256 = "9" * 64


def _embedding_for(person: str, dims: int = 512) -> np.ndarray:
    """A deterministic, biometric-free stand-in embedding: same person string
    always yields the same unit vector; different strings yield (almost
    certainly) very different ones. Not a real face embedding in any sense."""
    seed = int(hashlib.sha256(person.encode()).hexdigest(), 16) % (2**32)
    rng = np.random.default_rng(seed)
    vector = rng.normal(size=dims).astype(np.float32)
    return vector / max(float(np.linalg.norm(vector)), 1e-12)


class DevFixtureAdapter:
    """Drop-in replacement for SeetaFaceSidecar during local development and
    automated tests. Raises if instantiated with APP_ENV=production."""

    def __init__(self, app_env: str | None = None) -> None:
        import os

        if (app_env or os.environ.get("APP_ENV", "")).lower() == "production":
            raise RuntimeError("DevFixtureAdapter must never be used when APP_ENV=production.")

    def analyse(self, jpeg_bytes: bytes, challenge_id: str) -> SeetaFaceAnalysis:
        if not challenge_id:
            raise ValueError("challenge_id is required")
        try:
            fixture = json.loads(jpeg_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            fixture = {"person": hashlib.sha256(jpeg_bytes).hexdigest()[:12]}

        person = str(fixture.get("person", "unknown"))
        quality = CaptureQuality(
            face_detected=bool(fixture.get("faceDetected", True)),
            quality_score=float(fixture.get("quality", 0.97)),
            pose_degrees=float(fixture.get("pose", 2.0)),
            occlusion_score=float(fixture.get("occlusion", 0.02)),
        )
        is_live = bool(fixture.get("live", True))
        liveness = LivenessResult(
            is_live=is_live,
            score=float(fixture.get("livenessScore", 0.99 if is_live else 0.10)),
            attack_type=fixture.get("attackType"),
        )
        face = FaceSample(_embedding_for(person), quality, DEV_FACE_MODEL_ID, DEV_FACE_MODEL_SHA256)
        return SeetaFaceAnalysis(face, liveness, DEV_PAD_MODEL_ID, DEV_PAD_MODEL_SHA256)


class DevFingerprintFixtureAdapter:
    """Drop-in replacement for FingerprintSidecar during local development and
    automated tests. Fixture "images" are JSON documents (never real prints),
    e.g. {"finger": "alice-r-index", "quality": 0.9, "pad": true}. Templates
    are deterministic JSON blobs; same finger string -> score 0.97, different
    -> 0.06. Raises if instantiated with APP_ENV=production."""

    def __init__(self, app_env: str | None = None) -> None:
        import os

        if (app_env or os.environ.get("APP_ENV", "")).lower() == "production":
            raise RuntimeError("DevFingerprintFixtureAdapter must never be used when APP_ENV=production.")

    def analyse(self, image_bytes: bytes, challenge_id: str) -> FingerprintAnalysis:
        if not challenge_id:
            raise ValueError("challenge_id is required")
        try:
            fixture = json.loads(image_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            fixture = {"finger": hashlib.sha256(image_bytes).hexdigest()[:12]}

        finger = str(fixture.get("finger", "unknown"))
        quality = FingerprintQuality(
            finger_detected=bool(fixture.get("fingerDetected", True)),
            quality_score=float(fixture.get("quality", 0.85)),
            minutiae_count=int(fixture.get("minutiae", 34)),
        )
        pad: FingerprintPad | None = None
        if fixture.get("pad") is not None:
            is_live = bool(fixture.get("padLive", True))
            pad = FingerprintPad(is_live, float(fixture.get("padScore", 0.98 if is_live else 0.05)),
                                 fixture.get("attackType"), DEV_FP_PAD_MODEL_ID, DEV_FP_PAD_MODEL_SHA256)
        template = json.dumps({"dev_fixture_finger": finger}, sort_keys=True).encode()
        sample = FingerprintSample(template, quality, DEV_FP_MODEL_ID, DEV_FP_MODEL_SHA256)
        return FingerprintAnalysis(sample, pad)

    def compare(self, template_a: bytes, template_b: bytes) -> FingerprintComparison:
        def finger_of(template: bytes) -> str:
            try:
                return str(json.loads(template.decode())["dev_fixture_finger"])
            except Exception as exc:  # noqa: BLE001 — deliberately opaque
                raise ValueError("Template is not a dev fixture template.") from exc

        score = 0.97 if finger_of(template_a) == finger_of(template_b) else 0.06
        return FingerprintComparison(score, DEV_FP_MATCHER_MODEL_ID, DEV_FP_MATCHER_MODEL_SHA256)
