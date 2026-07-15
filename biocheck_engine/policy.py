from __future__ import annotations

from dataclasses import dataclass

from .types import Decision


@dataclass(frozen=True)
class VerificationPolicy:
    policy_id: str = "biocheck-1to1-v1"
    min_quality: float = 0.72
    max_pose_degrees: float = 25.0
    max_occlusion: float = 0.20
    min_liveness: float = 0.93
    approve_similarity: float = 0.74
    review_similarity: float = 0.62

    def decide(self, *, face_detected: bool, quality: float, pose: float, occlusion: float,
               is_live: bool, liveness: float, similarity: float) -> tuple[Decision, str]:
        if not face_detected:
            return Decision.REJECTED, "FACE_NOT_DETECTED"
        if quality < self.min_quality or abs(pose) > self.max_pose_degrees or occlusion > self.max_occlusion:
            return Decision.REVIEW, "CAPTURE_QUALITY_INSUFFICIENT"
        if not is_live or liveness < self.min_liveness:
            return Decision.REJECTED, "LIVENESS_FAILED"
        if similarity >= self.approve_similarity:
            return Decision.APPROVED, "MATCH_CONFIRMED"
        if similarity >= self.review_similarity:
            return Decision.REVIEW, "MATCH_REQUIRES_HUMAN_REVIEW"
        return Decision.REJECTED, "MATCH_NOT_CONFIRMED"


@dataclass(frozen=True)
class FingerprintVerificationPolicy:
    """1:1 fingerprint decision policy.

    Fingerprint PAD (fake-finger detection) depends on capture hardware. This
    policy therefore NEVER auto-approves without a live PAD result: a strong
    match with absent PAD is capped at REVIEW. Thresholds are placeholders for
    calibration during the pilot — they are policy inputs, not accuracy claims.
    """
    policy_id: str = "biocheck-fp-1to1-v1"
    min_quality: float = 0.60
    min_minutiae: int = 16
    approve_score: float = 0.80
    review_score: float = 0.55
    require_pad_for_approval: bool = True

    def decide(self, *, finger_detected: bool, quality: float, minutiae_count: int,
               pad_present: bool, pad_is_live: bool, score: float) -> tuple[Decision, str]:
        if not finger_detected:
            return Decision.REJECTED, "FINGER_NOT_DETECTED"
        if quality < self.min_quality or minutiae_count < self.min_minutiae:
            return Decision.REVIEW, "CAPTURE_QUALITY_INSUFFICIENT"
        if pad_present and not pad_is_live:
            return Decision.REJECTED, "PAD_FAILED"
        if score >= self.approve_score:
            if self.require_pad_for_approval and not (pad_present and pad_is_live):
                return Decision.REVIEW, "PAD_UNAVAILABLE_REVIEW_REQUIRED"
            return Decision.APPROVED, "MATCH_CONFIRMED"
        if score >= self.review_score:
            return Decision.REVIEW, "MATCH_REQUIRES_HUMAN_REVIEW"
        return Decision.REJECTED, "MATCH_NOT_CONFIRMED"
