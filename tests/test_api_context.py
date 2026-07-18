import base64
import importlib
import os

import pytest


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("VERIFY_CORE_DEV_FIXTURES", "true")
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("BIOCHECK_MASTER_KEY_B64",
                       base64.urlsafe_b64encode(b"0" * 32).decode())
    monkeypatch.delenv("VERIFY_CORE_API_KEY", raising=False)
    from fastapi.testclient import TestClient
    from biocheck_engine import api
    return TestClient(api.create_app())


def test_otp_issue_and_verify_roundtrip(client):
    issued = client.post("/v1/context/stepup/otp/issue",
                         json={"tenant_id": "t1", "subject_ref": "s1"}).json()
    assert issued["status"] == "pending" and issued["challenge_id"]
    assert "dev_otp" in issued  # dev fixtures mode only
    verified = client.post("/v1/context/stepup/otp/verify",
                           json={"challenge_id": issued["challenge_id"],
                                 "otp": issued["dev_otp"]}).json()
    assert verified["status"] == "satisfied"


def test_pin_enrol_and_verify(client):
    assert client.post("/v1/context/stepup/pin/enrol",
                       json={"tenant_id": "t1", "subject_ref": "s1", "pin": "4821"}
                       ).json() == {"enrolled": True}
    ok = client.post("/v1/context/stepup/pin/verify",
                     json={"tenant_id": "t1", "subject_ref": "s1", "pin": "4821"}).json()
    assert ok["status"] == "satisfied"
    bad = client.post("/v1/context/stepup/pin/enrol",
                      json={"tenant_id": "t1", "subject_ref": "s1", "pin": "x"})
    assert bad.status_code == 422


def test_device_observe(client):
    first = client.post("/v1/context/device/observe",
                        json={"tenant_id": "t1", "subject_ref": "s1",
                              "device_ref": "dev-a"}).json()
    assert first["level"] == "unknown"
    second = client.post("/v1/context/device/observe",
                         json={"tenant_id": "t1", "subject_ref": "s1",
                               "device_ref": "dev-a"}).json()
    assert second["level"] == "known"
    invalid = client.post("/v1/context/device/observe",
                          json={"tenant_id": "t1", "subject_ref": "s1",
                                "device_ref": "dev-a",
                                "attestation": {"verdict": "nonsense"}})
    assert invalid.status_code == 422


def test_location_evaluate(client):
    missing = client.post("/v1/context/location/evaluate",
                          json={"tenant_id": "t1", "subject_ref": "s1"}).json()
    assert missing["risk"] == "elevated" and missing["reason_code"] == "LOCATION_MISSING"
    ok = client.post("/v1/context/location/evaluate",
                     json={"tenant_id": "t1", "subject_ref": "s1",
                           "observation": {"latitude": -17.83, "longitude": 31.05,
                                            "country_code": "ZW"}}).json()
    assert ok["risk"] == "normal"


def test_orchestrate_end_to_end(client):
    body = {"tenant_id": "t1", "subject_ref": "s1",
            "modalities": [{"modality": "face", "decision": "approved",
                             "reason_code": "MATCH_CONFIRMED"}],
            "location": {"latitude": -17.83, "longitude": 31.05, "country_code": "ZW"}}
    d = client.post("/v1/context/orchestrate", json=body).json()
    assert d["outcome"] == "approved" and d["audit_hash"]

    rejected = dict(body)
    rejected["modalities"] = [{"modality": "face", "decision": "rejected",
                                "reason_code": "LIVENESS_FAILED"}]
    d2 = client.post("/v1/context/orchestrate", json=rejected).json()
    assert d2["outcome"] == "rejected"

    invalid = dict(body)
    invalid["modalities"] = [{"modality": "face", "decision": "yes",
                               "reason_code": "X"}]
    assert client.post("/v1/context/orchestrate", json=invalid).status_code == 422


def test_mrz_endpoint(client):
    lines = ["P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
             "L898902C36UTO7408122F1204159ZE184226B<<<<<10"]
    r = client.post("/v1/documents/mrz", json={"lines": lines}).json()
    assert r["format"] == "TD3" and r["surname"] == "ERIKSSON"
    assert "genuineness" in r["note"]
    too_big = client.post("/v1/documents/mrz", json={"lines": ["x" * 65]})
    assert too_big.status_code == 400


def test_context_endpoints_require_auth_when_key_set(monkeypatch):
    monkeypatch.setenv("VERIFY_CORE_DEV_FIXTURES", "true")
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("VERIFY_CORE_API_KEY", "secret-key")
    monkeypatch.setenv("BIOCHECK_MASTER_KEY_B64",
                       base64.urlsafe_b64encode(b"0" * 32).decode())
    from fastapi.testclient import TestClient
    from biocheck_engine import api
    client = TestClient(api.create_app())
    denied = client.post("/v1/context/stepup/otp/issue",
                         json={"tenant_id": "t1", "subject_ref": "s1"})
    assert denied.status_code == 401
    allowed = client.post("/v1/context/stepup/otp/issue",
                          json={"tenant_id": "t1", "subject_ref": "s1"},
                          headers={"Authorization": "Bearer secret-key"})
    assert allowed.status_code == 200
