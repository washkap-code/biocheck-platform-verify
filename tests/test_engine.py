import base64
import os
import unittest

import numpy as np

os.environ["BIOCHECK_MASTER_KEY_B64"] = base64.urlsafe_b64encode(b"x" * 32).decode()

from biocheck_engine.service import VerificationService
from biocheck_engine.types import CaptureQuality, FaceSample, LivenessResult, Decision
from biocheck_engine.model_registry import ModelCard, ModelRegistry
from biocheck_engine.providers.seetaface import SeetaFaceSidecar


def sample(vector: np.ndarray) -> FaceSample:
    return FaceSample(vector.astype(np.float32), CaptureQuality(True, .98, 1, .01), "model-a", "sha-a")


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.engine = VerificationService()
        self.reference = sample(np.ones(8))
        self.engine.enrol("tenant", "person", self.reference, "consent-1")

    def test_same_person_is_approved(self):
        result = self.engine.verify("tenant", "person", self.reference, LivenessResult(True, .99))
        self.assertEqual(result.decision, Decision.APPROVED)
        self.assertTrue(self.engine.audit.verify())

    def test_spoof_is_rejected_even_with_matching_face(self):
        result = self.engine.verify("tenant", "person", self.reference, LivenessResult(False, .99, "replay"))
        self.assertEqual(result.decision, Decision.REJECTED)
        self.assertEqual(result.reason_code, "LIVENESS_FAILED")

    def test_other_person_is_rejected(self):
        result = self.engine.verify("tenant", "person", sample(np.array([1, -1] * 4)), LivenessResult(True, .99))
        self.assertEqual(result.decision, Decision.REJECTED)

    def test_model_change_requires_review(self):
        changed = FaceSample(np.ones(8), CaptureQuality(True, .98, 1, .01), "model-b", "sha-b")
        result = self.engine.verify("tenant", "person", changed, LivenessResult(True, .99))
        self.assertEqual(result.decision, Decision.REVIEW)

    def test_model_registry_blocks_wrong_hash(self):
        registry = ModelRegistry()
        card = ModelCard("model-a", "a" * 64, "face_embedding", True, "LAB-2026-001", "ML assurance", "2027-01-01")
        registry.approve(card)
        registry.assert_allowed("model-a", "a" * 64, "face_embedding")
        with self.assertRaises(PermissionError):
            registry.assert_allowed("model-a", "b" * 64, "face_embedding")

    def test_model_registry_rejects_unlicensed_model(self):
        card = ModelCard("model", "a" * 64, "face_embedding", False, "report", "owner", "2027-01-01")
        with self.assertRaises(ValueError):
            ModelRegistry().approve(card)

    def test_seetaface_adapter_requires_approved_embedding_and_pad(self):
        registry = ModelRegistry()
        registry.approve(ModelCard("seeta-rec", "a" * 64, "face_embedding", True, "EVAL-1", "ML", "2027-01-01"))
        registry.approve(ModelCard("seeta-pad", "b" * 64, "passive_pad", True, "PAD-1", "ML", "2027-01-01"))
        response = {
            "embedding": [1.0] * 512, "model_id": "seeta-rec", "model_sha256": "a" * 64,
            "quality": {"face_detected": True, "score": .98, "pose_degrees": 1.2, "occlusion_score": .01},
            "passive_pad": {"model_id": "seeta-pad", "model_sha256": "b" * 64, "is_live": True, "score": .99},
        }
        adapter = SeetaFaceSidecar("http://localhost:9000", "test", registry, lambda _: __import__("json").dumps(response).encode())
        analysis = adapter.analyse(b"jpeg", "challenge-1")
        self.assertEqual(analysis.face.model_id, "seeta-rec")
        self.assertTrue(analysis.liveness.is_live)

    def test_seetaface_adapter_rejects_unknown_pad_model(self):
        registry = ModelRegistry()
        registry.approve(ModelCard("seeta-rec", "a" * 64, "face_embedding", True, "EVAL-1", "ML", "2027-01-01"))
        response = {
            "embedding": [1.0] * 512, "model_id": "seeta-rec", "model_sha256": "a" * 64,
            "quality": {"face_detected": True, "score": .98, "pose_degrees": 1.2, "occlusion_score": .01},
            "passive_pad": {"model_id": "unknown", "model_sha256": "b" * 64, "is_live": True, "score": .99},
        }
        adapter = SeetaFaceSidecar("http://localhost:9000", "test", registry, lambda _: __import__("json").dumps(response).encode())
        with self.assertRaises(PermissionError):
            adapter.analyse(b"jpeg", "challenge-1")
