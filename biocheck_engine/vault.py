from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .crypto import EncryptedBlob, decrypt_json, encrypt_json


@dataclass(frozen=True)
class TemplateRecord:
    subject_ref: str
    model_id: str
    model_sha256: str
    blob: EncryptedBlob


class TemplateVault:
    """Replace this in-memory adapter with an HSM-backed transactional store."""
    def __init__(self) -> None:
        self._records: dict[tuple[str, str], TemplateRecord] = {}

    def enrol(self, tenant_id: str, subject_ref: str, embedding: np.ndarray, model_id: str, model_sha256: str) -> None:
        if embedding.ndim != 1 or not np.isfinite(embedding).all():
            raise ValueError("Invalid embedding")
        vector = embedding.astype(np.float32)
        vector /= max(float(np.linalg.norm(vector)), 1e-12)
        blob = encrypt_json(tenant_id, {"embedding": vector.tolist()})
        self._records[(tenant_id, subject_ref)] = TemplateRecord(subject_ref, model_id, model_sha256, blob)

    def retrieve(self, tenant_id: str, subject_ref: str) -> tuple[np.ndarray, TemplateRecord] | None:
        record = self._records.get((tenant_id, subject_ref))
        if record is None:
            return None
        data = decrypt_json(tenant_id, record.blob)
        return np.asarray(data["embedding"], dtype=np.float32), record
