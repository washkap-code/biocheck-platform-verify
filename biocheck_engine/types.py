from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Mapping

import numpy as np


class Decision(str, Enum):
    APPROVED = "approved"
    REVIEW = "review"
    REJECTED = "rejected"


@dataclass(frozen=True)
class CaptureQuality:
    face_detected: bool
    quality_score: float
    pose_degrees: float
    occlusion_score: float


@dataclass(frozen=True)
class LivenessResult:
    is_live: bool
    score: float
    attack_type: str | None = None


@dataclass(frozen=True)
class FaceSample:
    embedding: np.ndarray
    quality: CaptureQuality
    model_id: str
    model_sha256: str


@dataclass(frozen=True)
class FingerprintQuality:
    finger_detected: bool
    quality_score: float  # normalised 0..1 (real sidecar derives this from NFIQ2)
    minutiae_count: int


@dataclass(frozen=True)
class FingerprintPad:
    """Presentation-attack detection for fingerprint. Only available when the
    capture device/sidecar actually performs it — never synthesised."""
    is_live: bool
    score: float
    attack_type: str | None
    model_id: str
    model_sha256: str


@dataclass(frozen=True)
class FingerprintSample:
    template: bytes  # opaque minutiae template (ISO/IEC 19794-2 in the real sidecar)
    quality: FingerprintQuality
    model_id: str
    model_sha256: str


@dataclass(frozen=True)
class VerificationResult:
    decision: Decision
    reason_code: str
    similarity: float | None
    liveness_score: float | None
    model_id: str
    policy_id: str
    correlation_id: str
    audit_hash: str
    signals: Mapping[str, float | bool | str]
