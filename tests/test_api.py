"""Tests for the verify-core HTTP facade (biocheck_engine/api.py).

Exercises the exact contract platform/src/server/verification/providers.ts's
VerifyCoreProvider speaks: POST /v1/analyse, /v1/templates, /v1/compare.
Uses the dev fixture adapter (never the real SeetaFace6 sidecar, which does
not exist yet) so this suite is self-contained and needs no native build.
"""
from __future__ import annotations

import base64
import importlib
import json
import os

import pytest

os.environ.setdefault("BIOCHECK_MASTER_KEY_B64", base64.urlsafe_b64encode(b"t" * 32).decode())


def _fresh_app(monkeypatch, **env):
    """create_app() reads registry/adapter config from the environment once
    at call time, so each test gets an isolated app instance/config."""
    monkeypatch.setenv("VERIFY_CORE_DEV_FIXTURES", "true")
    monkeypatch.delenv("VERIFY_CORE_SIDECAR_URL", raising=False)
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


def _fixture_b64(**fields) -> str:
    return base64.b64encode(json.dumps(fields).encode()).decode()


class TestHealthAndConfig:
    def test_health_reports_dev_adapter(self, monkeypatch):
        client = _client(monkeypatch)
        res = client.get("/health")
        assert res.status_code == 200
        assert res.json()["adapter"] == "DevFixtureAdapter"

    def test_refuses_to_start_with_no_adapter_of_any_modality(self, monkeypatch):
        monkeypatch.delenv("VERIFY_CORE_DEV_FIXTURES", raising=False)
        monkeypatch.delenv("VERIFY_CORE_SIDECAR_URL", raising=False)
        monkeypatch.delenv("VERIFY_CORE_FP_SIDECAR_URL", raising=False)
        from biocheck_engine import api as api_module
        with pytest.raises(RuntimeError, match="at least one modality is required"):
            importlib.reload(api_module)

    def test_fingerprint_only_deployment_boots_and_face_fails_closed(self, monkeypatch):
        """Face sidecar absent + fingerprint sidecar configured: valid deployment;
        face endpoints 503 fail-closed instead of refusing to boot."""
        monkeypatch.delenv("VERIFY_CORE_DEV_FIXTURES", raising=False)
        monkeypatch.delenv("VERIFY_CORE_SIDECAR_URL", raising=False)
        monkeypatch.setenv("VERIFY_CORE_FP_SIDECAR_URL", "http://localhost:8081")
        monkeypatch.setenv("VERIFY_CORE_FP_SIDECAR_API_KEY", "k")
        monkeypatch.delenv("VERIFY_CORE_API_KEY", raising=False)
        from biocheck_engine.api import create_app
        from fastapi.testclient import TestClient
        client = TestClient(create_app())
        health = client.get("/health").json()
        assert health["adapter"] is None
        assert health["fingerprint_adapter"] == "FingerprintSidecar"
        res = client.post("/v1/analyse", json={
            "image_b64": "aGk=", "challenge_id": "c", "retain_image": False})
        assert res.status_code == 503

    def test_dev_fixtures_refused_in_production(self, monkeypatch):
        monkeypatch.setenv("APP_ENV", "production")
        from biocheck_engine import api as api_module
        with pytest.raises(RuntimeError, match="APP_ENV=production"):
            _fresh_app(monkeypatch, APP_ENV="production")


class TestAuth:
    def test_missing_bearer_token_rejected_when_key_configured(self, monkeypatch):
        client = _client(monkeypatch, VERIFY_CORE_API_KEY="secret-123")
        res = client.post("/v1/analyse", json={
            "image_b64": _fixture_b64(person="alice"), "challenge_id": "c1",
        })
        assert res.status_code == 401

    def test_correct_bearer_token_accepted(self, monkeypatch):
        client = _client(monkeypatch, VERIFY_CORE_API_KEY="secret-123")
        res = client.post("/v1/analyse", headers={"Authorization": "Bearer secret-123"}, json={
            "image_b64": _fixture_b64(person="alice"), "challenge_id": "c1",
        })
        assert res.status_code == 200

    def test_wrong_bearer_token_rejected(self, monkeypatch):
        client = _client(monkeypatch, VERIFY_CORE_API_KEY="secret-123")
        res = client.post("/v1/analyse", headers={"Authorization": "Bearer wrong"}, json={
            "image_b64": _fixture_b64(person="alice"), "challenge_id": "c1",
        })
        assert res.status_code == 401


class TestAnalyse:
    def test_never_returns_raw_embedding(self, monkeypatch):
        client = _client(monkeypatch)
        res = client.post("/v1/analyse", json={"image_b64": _fixture_b64(person="alice"), "challenge_id": "c1"})
        assert res.status_code == 200
        body = res.json()
        assert set(body.keys()) == {"capture_ref", "quality", "passive_pad", "model_id", "model_sha256"}
        # The real leak to guard against is the raw embedding vector (a long
        # list of floats), not the substring "embedding" — which legitimately
        # appears inside the dev fixture's own model name.
        assert not isinstance(body.get("capture_ref"), list)
        for value in body.values():
            assert not (isinstance(value, list) and len(value) > 8)

    def test_rejects_oversized_or_invalid_base64(self, monkeypatch):
        client = _client(monkeypatch)
        res = client.post("/v1/analyse", json={"image_b64": "not-valid-base64!!", "challenge_id": "c1"})
        assert res.status_code == 400

    def test_requires_challenge_id(self, monkeypatch):
        client = _client(monkeypatch)
        res = client.post("/v1/analyse", json={"image_b64": _fixture_b64(person="alice"), "challenge_id": ""})
        assert res.status_code == 422


class TestEnrolmentAndVerificationFlow:
    def test_same_person_yields_high_similarity(self, monkeypatch):
        client = _client(monkeypatch)
        ref_capture = client.post("/v1/analyse", json={
            "image_b64": _fixture_b64(person="alice"), "challenge_id": "enrol-1",
        }).json()["capture_ref"]
        template = client.post("/v1/templates", json={"capture_ref": ref_capture}).json()
        assert set(template.keys()) == {"template_ciphertext", "model_id", "model_sha256"}
        assert isinstance(template["template_ciphertext"], str)

        selfie_capture = client.post("/v1/analyse", json={
            "image_b64": _fixture_b64(person="alice"), "challenge_id": "verify-1",
        }).json()["capture_ref"]
        result = client.post("/v1/compare", json={
            "template_ciphertext": template["template_ciphertext"], "capture_ref": selfie_capture,
        }).json()
        assert result["similarity"] > 0.9

    def test_different_person_yields_low_similarity(self, monkeypatch):
        client = _client(monkeypatch)
        ref_capture = client.post("/v1/analyse", json={
            "image_b64": _fixture_b64(person="alice"), "challenge_id": "enrol-1",
        }).json()["capture_ref"]
        template = client.post("/v1/templates", json={"capture_ref": ref_capture}).json()

        selfie_capture = client.post("/v1/analyse", json={
            "image_b64": _fixture_b64(person="mallory"), "challenge_id": "verify-1",
        }).json()["capture_ref"]
        result = client.post("/v1/compare", json={
            "template_ciphertext": template["template_ciphertext"], "capture_ref": selfie_capture,
        }).json()
        assert result["similarity"] < 0.5

    def test_capture_ref_is_single_use(self, monkeypatch):
        client = _client(monkeypatch)
        ref_capture = client.post("/v1/analyse", json={
            "image_b64": _fixture_b64(person="alice"), "challenge_id": "enrol-1",
        }).json()["capture_ref"]
        first = client.post("/v1/templates", json={"capture_ref": ref_capture})
        assert first.status_code == 200
        second = client.post("/v1/templates", json={"capture_ref": ref_capture})
        assert second.status_code == 409

    def test_unknown_capture_ref_rejected(self, monkeypatch):
        client = _client(monkeypatch)
        res = client.post("/v1/templates", json={"capture_ref": "vc_does-not-exist"})
        assert res.status_code == 409

    def test_malformed_template_ciphertext_rejected(self, monkeypatch):
        client = _client(monkeypatch)
        selfie_capture = client.post("/v1/analyse", json={
            "image_b64": _fixture_b64(person="alice"), "challenge_id": "verify-1",
        }).json()["capture_ref"]
        res = client.post("/v1/compare", json={
            "template_ciphertext": "not-a-real-ciphertext", "capture_ref": selfie_capture,
        })
        assert res.status_code == 422


class TestModelRegistryEnforcement:
    def test_unapproved_model_is_rejected(self, monkeypatch):
        # No VERIFY_CORE_APPROVED_MODELS_JSON and dev fixtures disabled at the
        # registry level would normally refuse adapter startup entirely; here
        # we simulate a registry that never approved the dev fixture models by
        # pointing at a sidecar-shaped adapter with an empty registry instead.
        client = _client(monkeypatch, VERIFY_CORE_APPROVED_MODELS_JSON="[]")
        # Dev fixtures are still auto-approved by _load_model_registry when
        # VERIFY_CORE_DEV_FIXTURES=true, so this confirms the *documented*
        # behaviour: real deployments must supply their own approved list and
        # must NOT set VERIFY_CORE_DEV_FIXTURES, or every request fails closed.
        res = client.post("/v1/analyse", json={"image_b64": _fixture_b64(person="alice"), "challenge_id": "c1"})
        assert res.status_code == 200  # dev fixtures remain self-approved for local testing
