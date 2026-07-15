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

from .providers.seetaface import SeetaFaceAnalysis
from .types import CaptureQuality, FaceSample, LivenessResult

DEV_FACE_MODEL_ID = "dev-fixture-embedding-v1"
DEV_FACE_MODEL_SHA256 = "d" * 64
DEV_PAD_MODEL_ID = "dev-fixture-pad-v1"
DEV_PAD_MODEL_SHA256 = "c" * 64


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
