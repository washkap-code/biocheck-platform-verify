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
