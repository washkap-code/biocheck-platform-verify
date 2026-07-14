from __future__ import annotations

import hashlib
import uuid

import numpy as np

from .audit import AuditChain
from .policy import VerificationPolicy
from .types import Decision, FaceSample, LivenessResult, VerificationResult
from .vault import TemplateVault


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    if a.shape != b.shape:
        raise ValueError("Model/template dimension mismatch")
    a, b = a.astype(np.float64), b.astype(np.float64)
    return float(np.dot(a, b) / max(np.linalg.norm(a) * np.linalg.norm(b), 1e-12))


class VerificationService:
    def __init__(self, vault: TemplateVault | None = None, audit: AuditChain | None = None,
                 policy: VerificationPolicy | None = None) -> None:
        self.vault, self.audit, self.policy = vault or TemplateVault(), audit or AuditChain(), policy or VerificationPolicy()

    def enrol(self, tenant_id: str, subject_ref: str, sample: FaceSample, consent_receipt: str) -> None:
        if not consent_receipt:
            raise ValueError("A consent receipt/reference is required for enrolment.")
        q = sample.quality
        if not q.face_detected or q.quality_score < self.policy.min_quality:
            raise ValueError("Reference capture quality is insufficient.")
        self.vault.enrol(tenant_id, subject_ref, sample.embedding, sample.model_id, sample.model_sha256)

    def verify(self, tenant_id: str, subject_ref: str, selfie: FaceSample, liveness: LivenessResult) -> VerificationResult:
        correlation_id = str(uuid.uuid4())
        found = self.vault.retrieve(tenant_id, subject_ref)
        if found is None:
            result = VerificationResult(Decision.REJECTED, "REFERENCE_NOT_FOUND", None, liveness.score,
                selfie.model_id, self.policy.policy_id, correlation_id, "", {})
        else:
            reference, record = found
            if record.model_id != selfie.model_id or record.model_sha256 != selfie.model_sha256:
                result = VerificationResult(Decision.REVIEW, "MODEL_VERSION_MISMATCH", None, liveness.score,
                    selfie.model_id, self.policy.policy_id, correlation_id, "", {})
            else:
                similarity = cosine_similarity(reference, selfie.embedding)
                q = selfie.quality
                decision, reason = self.policy.decide(face_detected=q.face_detected, quality=q.quality_score,
                    pose=q.pose_degrees, occlusion=q.occlusion_score, is_live=liveness.is_live,
                    liveness=liveness.score, similarity=similarity)
                result = VerificationResult(decision, reason, similarity, liveness.score, selfie.model_id,
                    self.policy.policy_id, correlation_id, "", {"quality": q.quality_score, "pose": q.pose_degrees,
                    "occlusion": q.occlusion_score, "liveness": liveness.score})
        event_hash = self.audit.append(result, tenant_id, subject_ref)
        return VerificationResult(**{**result.__dict__, "audit_hash": event_hash})
