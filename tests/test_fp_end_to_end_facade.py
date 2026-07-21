"""End-to-end test: real facade + real Python fingerprint sidecar.

Unlike test_fp_sidecar_conformance.py (which talks to the sidecar directly
through the engine's client class), this test goes through the actual
production HTTP surface: biocheck_engine.api's FastAPI app, over real HTTP,
with the sidecar also running as a separate real HTTP service — exactly the
topology a real deployment would use. It exercises the full enrol -> encrypted
template -> verify flow, including the single-use capture_ref semantics.

Requires `fastapi`, `uvicorn` (the `api` extra in pyproject.toml). Skipped
automatically if they aren't installed, so it doesn't break the base test
run for anyone who hasn't installed the optional API extra.

Run: python3 -m pytest tests/test_fp_end_to_end_facade.py -v -s
"""
from __future__ import annotations

import base64
import json
import math
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("uvicorn")

REPO_ROOT = Path(__file__).resolve().parent.parent
SIDECAR_DIR = REPO_ROOT / "sidecar-fingerprint-py"
sys.path.insert(0, str(SIDECAR_DIR))


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_up(url: str, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    last_exc = None
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1)
            return
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            time.sleep(0.2)
    raise RuntimeError(f"{url} did not come up in time: {last_exc}")


def _post(base: str, path: str, body: dict):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                                  method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


@pytest.fixture(scope="module")
def stack():
    """Boots the real sidecar and the real facade as separate subprocesses,
    fully wired together, and tears them down afterwards."""
    sidecar_port = _free_port()
    facade_port = _free_port()
    fp_key = "e2e-test-key"

    sidecar_env = {**os.environ, "FP_SIDECAR_API_KEY": fp_key, "FP_SIDECAR_PORT": str(sidecar_port)}
    sidecar_proc = subprocess.Popen(
        [sys.executable, str(SIDECAR_DIR / "server.py")],
        env=sidecar_env, cwd=str(SIDECAR_DIR),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    sidecar_base = f"http://127.0.0.1:{sidecar_port}"
    _wait_up(sidecar_base + "/healthz")

    with urllib.request.urlopen(sidecar_base + "/healthz", timeout=5) as r:
        health = json.load(r)

    approved = [
        {
            "model_id": health["model_id"], "sha256": health["model_sha256"],
            "purpose": "fingerprint_extraction", "commercial_use_approved": True,
            "independent_report_ref": "Test-only registration for test_fp_end_to_end_facade.py; "
                                       "no independent evaluation performed.",
            "approved_by": "pytest-e2e", "expires_on": "2027-12-31",
        },
        {
            "model_id": health["matcher_model_id"], "sha256": health["model_sha256"],
            "purpose": "fingerprint_matching", "commercial_use_approved": True,
            "independent_report_ref": "Test-only registration for test_fp_end_to_end_facade.py; "
                                       "no independent evaluation performed.",
            "approved_by": "pytest-e2e", "expires_on": "2027-12-31",
        },
    ]

    facade_env = {
        **os.environ,
        "VERIFY_CORE_FP_SIDECAR_URL": sidecar_base,
        "VERIFY_CORE_FP_SIDECAR_API_KEY": fp_key,
        "VERIFY_CORE_APPROVED_MODELS_JSON": json.dumps(approved),
        "BIOCHECK_MASTER_KEY_B64": base64.urlsafe_b64encode(os.urandom(32)).decode(),
    }
    facade_proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "biocheck_engine.api:app",
         "--host", "127.0.0.1", "--port", str(facade_port)],
        env=facade_env, cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    facade_base = f"http://127.0.0.1:{facade_port}"
    _wait_up(facade_base + "/health", timeout=15)

    yield facade_base

    sidecar_proc.terminate()
    facade_proc.terminate()
    sidecar_proc.wait(timeout=5)
    facade_proc.wait(timeout=5)


def _synth(seed, core=(110, 100), freq=0.15, shift=(0, 0), rot=0.0):
    from test_conformance import synth_fingerprint  # local import: needs sys.path insert above
    return synth_fingerprint(seed=seed, core=core, freq=freq, shift=shift, rot=rot)


def test_facade_reports_fingerprint_adapter(stack):
    with urllib.request.urlopen(stack + "/health", timeout=5) as r:
        body = json.load(r)
    assert body["fingerprint_adapter"] == "FingerprintSidecar"


def test_full_enrol_verify_flow_same_finger_beats_different_finger(stack):
    enrol_img = _synth(seed=500, core=(110, 100), freq=0.15)
    status, a1 = _post(stack, "/v1/fingerprint/analyse",
                        {"image_b64": base64.b64encode(enrol_img).decode(), "challenge_id": "enrol"})
    assert status == 200
    assert a1["quality"]["minutiae_count"] > 0
    assert a1["pad"] is None

    status, tpl = _post(stack, "/v1/fingerprint/templates", {"capture_ref": a1["capture_ref"]})
    assert status == 200
    ciphertext = tpl["template_ciphertext"]
    assert ciphertext.startswith("fp1:")

    same_img = _synth(seed=501, core=(110, 100), freq=0.15, shift=(5, -3), rot=math.radians(6))
    status, a2 = _post(stack, "/v1/fingerprint/analyse",
                        {"image_b64": base64.b64encode(same_img).decode(), "challenge_id": "verify-same"})
    assert status == 200
    status, same_cmp = _post(stack, "/v1/fingerprint/compare",
                              {"capture_ref": a2["capture_ref"], "template_ciphertext": ciphertext})
    assert status == 200

    diff_img = _synth(seed=777, core=(60, 150), freq=0.19, rot=math.radians(40))
    status, a3 = _post(stack, "/v1/fingerprint/analyse",
                        {"image_b64": base64.b64encode(diff_img).decode(), "challenge_id": "verify-diff"})
    assert status == 200
    status, diff_cmp = _post(stack, "/v1/fingerprint/compare",
                              {"capture_ref": a3["capture_ref"], "template_ciphertext": ciphertext})
    assert status == 200

    assert 0.0 <= same_cmp["score"] <= 1.0
    assert 0.0 <= diff_cmp["score"] <= 1.0
    assert same_cmp["score"] > diff_cmp["score"], (
        f"same={same_cmp['score']} diff={diff_cmp['score']} — see README.md: this is an "
        f"uncalibrated prototype, occasional ordering failures on hard synthetic pairs are expected "
        f"and documented, but this specific seed pair is asserted to pass."
    )

    # capture_ref must be single-use
    status, reuse = _post(stack, "/v1/fingerprint/compare",
                           {"capture_ref": a2["capture_ref"], "template_ciphertext": ciphertext})
    assert status == 409
