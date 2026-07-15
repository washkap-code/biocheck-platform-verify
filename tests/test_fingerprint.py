"""Tests for the fingerprint modality (policy, dev fixture adapter, facade).

The real fingerprint sidecar (scanner SDK + extractor/matcher) does not exist
yet — these tests exercise the contract and the fail-closed behaviour, using
the dev fixture adapter only. Nothing here is a claim of biometric accuracy.
"""
from __future__ import annotations

import base64
import importlib
import json
import os

import pytest

os.environ.setdefault("BIOCHECK_MASTER_KEY_B64", base64.urlsafe_b64encode(b"t" * 32).decode())

from biocheck_engine.policy import FingerprintVerificationPolicy
from biocheck_engine.types import Decision


def _fresh_app(monkeypatch, **env):
    monkeypatch.setenv("VERIFY_CORE_DEV_FIXTURES", "true")
    monkeypatch.delenv("VERIFY_CORE_SIDECAR_URL", raising=False)
    monkeypatch.delenv("VERIFY_CORE_FP_SIDECAR_URL", raising=False)
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("VERIFY_CORE_APPROVED_MODELS_JSON", raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    from biocheck_engine import api as api_module
    importlib.reload(api_module)
    return api_module


def _client(monkeypatch, **env):
    from fastapi.testclient import TestClient
    api_module = _fresh_app(monkeypatch, **env)
    return TestClient(api_module.app)


def _fp_fixture_b64(**fields) -> str:
    return base64.b64encode(json.dumps(fields).encode()).decode()


def _analyse(client, **fields):
    return client.post("/v1/fingerprint/analyse", json={
        "image_b64": _fp_fixture_b64(**fields), "challenge_id": "chal-1"})


class TestFingerprintPolicy:
    POLICY = FingerprintVerificationPolicy()

    def base(self, **overrides):
        params = dict(finger_detected=True, quality=0.85, minutiae_count=34,
                      pad_present=True, pad_is_live=True, score=0.95)
        params.update(overrides)
        return self.POLICY.decide(**params)

    def test_approves_strong_match_with_live_pad(self):
        assert self.base() == (Decision.APPROVED, "MATCH_CONFIRMED")

    def test_no_finger_rejected(self):
        assert self.base(finger_detected=False) == (Decision.REJECTED, "FINGER_NOT_DETECTED")

    def test_poor_quality_goes_to_review(self):
        decision, reason = self.base(quality=0.3)
        assert (decision, reason) == (Decision.REVIEW, "CAPTURE_QUALITY_INSUFFICIENT")

    def test_too_few_minutiae_goes_to_review(self):
        assert self.base(minutiae_count=5)[0] == Decision.REVIEW

    def test_pad_failure_rejected_even_with_perfect_match(self):
        assert self.base(pad_is_live=False) == (Decision.REJECTED, "PAD_FAILED")

    def test_strong_match_without_pad_is_capped_at_review(self):
        decision, reason = self.base(pad_present=False, pad_is_live=False)
        assert (decision, reason) == (Decision.REVIEW, "PAD_UNAVAILABLE_REVIEW_REQUIRED")

    def test_ambiguous_score_goes_to_review(self):
        assert self.base(score=0.60) == (Decision.REVIEW, "MATCH_REQUIRES_HUMAN_REVIEW")

    def test_low_score_rejected(self):
        assert self.base(score=0.10) == (Decision.REJECTED, "MATCH_NOT_CONFIRMED")


class TestDevFingerprintFixtureAdapter:
    def test_refuses_production(self, monkeypatch):
        from biocheck_engine.dev_fixture_adapter import DevFingerprintFixtureAdapter
        monkeypatch.setenv("APP_ENV", "production")
        with pytest.raises(RuntimeError, match="never be used"):
            DevFingerprintFixtureAdapter()

    def test_same_finger_high_score_different_finger_low(self, monkeypatch):
        from biocheck_engine.dev_fixture_adapter import DevFingerprintFixtureAdapter
        monkeypatch.delenv("APP_ENV", raising=False)
        adapter = DevFingerprintFixtureAdapter()
        a1 = adapter.analyse(json.dumps({"finger": "alice-r-index"}).encode(), "c1")
        a2 = adapter.analyse(json.dumps({"finger": "alice-r-index"}).encode(), "c2")
        b = adapter.analyse(json.dumps({"finger": "bob-r-index"}).encode(), "c3")
        assert adapter.compare(a1.sample.template, a2.sample.template).score > 0.9
        assert adapter.compare(a1.sample.template, b.sample.template).score < 0.2


class TestFacadeFingerprintEndpoints:
    def test_not_configured_fails_closed_503(self, monkeypatch):
        # Face adapter present, fingerprint deliberately unconfigured.
        monkeypatch.delenv("VERIFY_CORE_FP_SIDECAR_URL", raising=False)
        api_module = _fresh_app(monkeypatch)
        # Simulate face-only config: strip the fp adapter from a rebuilt app.
        monkeypatch.setenv("VERIFY_CORE_DEV_FIXTURES", "true")
        from fastapi.testclient import TestClient
        # Build an app where the fp adapter loader returns None.
        monkeypatch.setattr(api_module, "_load_fingerprint_adapter", lambda registry: None)
        client = TestClient(api_module.create_app())
        res = client.post("/v1/fingerprint/analyse",
                          json={"image_b64": _fp_fixture_b64(finger="x"), "challenge_id": "c"})
        assert res.status_code == 503
        assert "failing closed" in res.text

    def test_health_reports_fingerprint_adapter(self, monkeypatch):
        client = _client(monkeypatch)
        body = client.get("/health").json()
        assert body["fingerprint_adapter"] == "DevFingerprintFixtureAdapter"

    def test_full_enrol_and_match_flow(self, monkeypatch):
        client = _client(monkeypatch)
        enrol = _analyse(client, finger="alice-r-index", pad=True)
        assert enrol.status_code == 200
        template = client.post("/v1/fingerprint/templates",
                               json={"capture_ref": enrol.json()["capture_ref"]})
        assert template.status_code == 200
        ciphertext = template.json()["template_ciphertext"]
        assert ciphertext.startswith("fp1:")

        verify = _analyse(client, finger="alice-r-index", pad=True)
        compare = client.post("/v1/fingerprint/compare", json={
            "template_ciphertext": ciphertext, "capture_ref": verify.json()["capture_ref"]})
        assert compare.status_code == 200
        body = compare.json()
        assert body["score"] > 0.9
        assert body["pad"] == {"present": True, "is_live": True}
        assert body["matcher_model_id"]

    def test_different_finger_scores_low(self, monkeypatch):
        client = _client(monkeypatch)
        enrol = _analyse(client, finger="alice-r-index")
        ciphertext = client.post("/v1/fingerprint/templates", json={
            "capture_ref": enrol.json()["capture_ref"]}).json()["template_ciphertext"]
        verify = _analyse(client, finger="mallory-r-index")
        compare = client.post("/v1/fingerprint/compare", json={
            "template_ciphertext": ciphertext, "capture_ref": verify.json()["capture_ref"]})
        assert compare.json()["score"] < 0.2

    def test_capture_ref_is_single_use(self, monkeypatch):
        client = _client(monkeypatch)
        ref = _analyse(client, finger="alice").json()["capture_ref"]
        first = client.post("/v1/fingerprint/templates", json={"capture_ref": ref})
        second = client.post("/v1/fingerprint/templates", json={"capture_ref": ref})
        assert first.status_code == 200
        assert second.status_code == 409

    def test_face_capture_ref_rejected_by_fingerprint_endpoints(self, monkeypatch):
        client = _client(monkeypatch)
        face = client.post("/v1/analyse", json={
            "image_b64": base64.b64encode(json.dumps({"person": "alice"}).encode()).decode(),
            "challenge_id": "c1"})
        assert face.status_code == 200
        res = client.post("/v1/fingerprint/templates",
                          json={"capture_ref": face.json()["capture_ref"]})
        assert res.status_code == 409

    def test_face_template_ciphertext_rejected_by_fingerprint_compare(self, monkeypatch):
        client = _client(monkeypatch)
        face = client.post("/v1/analyse", json={
            "image_b64": base64.b64encode(json.dumps({"person": "alice"}).encode()).decode(),
            "challenge_id": "c1"})
        face_tpl = client.post("/v1/templates",
                               json={"capture_ref": face.json()["capture_ref"]}).json()
        fp = _analyse(client, finger="alice")
        res = client.post("/v1/fingerprint/compare", json={
            "template_ciphertext": face_tpl["template_ciphertext"],
            "capture_ref": fp.json()["capture_ref"]})
        assert res.status_code == 422

    def test_pad_absent_is_reported_not_invented(self, monkeypatch):
        client = _client(monkeypatch)
        res = _analyse(client, finger="alice")  # no pad field -> no PAD performed
        assert res.json()["pad"] is None

    def test_invalid_base64_rejected(self, monkeypatch):
        client = _client(monkeypatch)
        res = client.post("/v1/fingerprint/analyse",
                          json={"image_b64": "!!not-base64!!", "challenge_id": "c"})
        assert res.status_code == 400

    def test_auth_required_when_key_configured(self, monkeypatch):
        client = _client(monkeypatch, VERIFY_CORE_API_KEY="secret-key")
        res = client.post("/v1/fingerprint/analyse",
                          json={"image_b64": _fp_fixture_b64(finger="x"), "challenge_id": "c"})
        assert res.status_code == 401


class TestFingerprintSidecarClient:
    def _registry(self):
        from biocheck_engine.model_registry import ModelCard, ModelRegistry
        registry = ModelRegistry()
        registry.approve(ModelCard("fp-x", "1" * 64, "fingerprint_extraction",
                                   True, "REPORT-1", "tester", "2099-01-01"))
        registry.approve(ModelCard("fp-m", "2" * 64, "fingerprint_matching",
                                   True, "REPORT-2", "tester", "2099-01-01"))
        return registry

    def test_rejects_non_https_remote_endpoint(self):
        from biocheck_engine.providers.fingerprint import FingerprintSidecar
        with pytest.raises(ValueError, match="HTTPS"):
            FingerprintSidecar("http://fp.internal:8100", "k", self._registry())

    def test_unregistered_model_is_refused(self):
        from biocheck_engine.providers.fingerprint import FingerprintSidecar
        response = json.dumps({
            "template_b64": base64.b64encode(b"tpl").decode(),
            "model_id": "fp-unknown", "model_sha256": "9" * 64,
            "quality": {"finger_detected": True, "score": 0.9, "minutiae_count": 30},
        }).encode()
        sidecar = FingerprintSidecar("http://localhost:8100", "k", self._registry(),
                                     transport=lambda req: response)
        with pytest.raises(PermissionError):
            sidecar.analyse(b"img", "c1")

    def test_transport_failure_fails_closed(self):
        from biocheck_engine.providers.fingerprint import FingerprintSidecar

        def broken(req):
            raise OSError("connection refused")

        sidecar = FingerprintSidecar("http://localhost:8100", "k", self._registry(),
                                     transport=broken)
        with pytest.raises(RuntimeError, match="fail closed"):
            sidecar.analyse(b"img", "c1")

    def test_out_of_range_score_is_refused(self):
        from biocheck_engine.providers.fingerprint import FingerprintSidecar
        response = json.dumps({"score": 42.0, "matcher_model_id": "fp-m",
                               "matcher_model_sha256": "2" * 64}).encode()
        sidecar = FingerprintSidecar("http://localhost:8100", "k", self._registry(),
                                     transport=lambda req: response)
        with pytest.raises(RuntimeError, match="out-of-range"):
            sidecar.compare(b"a", b"b")
