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
