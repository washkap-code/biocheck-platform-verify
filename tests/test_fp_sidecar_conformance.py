"""Conformance tests for a *running* fingerprint sidecar (FP-001).

These tests exercise the real wire contract through the engine's own
FingerprintSidecar client. They are skipped unless a live sidecar is
configured:

    FP_SIDECAR_URL=http://localhost:8081 \
    FP_SIDECAR_API_KEY=devkey \
    pytest tests/test_fp_sidecar_conformance.py -v

They use a synthetic ridge-pattern image (generated in-process, no PIL
dependency). Synthetic images exercise the contract, decoding, template
serialisation and score mapping - they do NOT demonstrate biometric accuracy.
Accuracy evidence comes only from FP-005/FP-006 with real scanner captures.
"""
from __future__ import annotations

import base64
import json
import math
import os
import struct
import urllib.request
import zlib

import pytest

from biocheck_engine.model_registry import ModelCard, ModelRegistry
from biocheck_engine.providers.fingerprint import FingerprintSidecar

URL = os.environ.get("FP_SIDECAR_URL")
KEY = os.environ.get("FP_SIDECAR_API_KEY", "")

pytestmark = pytest.mark.skipif(
    not URL, reason="FP_SIDECAR_URL not set; conformance runs only against a live sidecar")


def _png_gray(width: int, height: int, pixels: bytes) -> bytes:
    """Minimal 8-bit grayscale PNG encoder (no external deps)."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        raw = tag + data
        return struct.pack(">I", len(data)) + raw + struct.pack(">I", zlib.crc32(raw))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    scanlines = b"".join(b"\x00" + pixels[y * width:(y + 1) * width] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b""))


def synthetic_fingerprint(seed: int = 7, size: int = 320) -> bytes:
    """Sinusoidal ridge pattern with radial distortion and breaks - enough
    structure for the extractor to find features. Not a real fingerprint."""
    px = bytearray(size * size)
    cx, cy = size / 2 + seed, size / 2 - seed
    for y in range(size):
        for x in range(size):
            dx, dy = x - cx, y - cy
            r = math.hypot(dx, dy)
            a = math.atan2(dy, dx)
            v = math.sin(r / 6.0 + 2.2 * math.sin(a * 3 + seed) + 0.02 * r)
            if (x * 7 + y * 13 + seed * 31) % 97 < 4:  # ridge breaks
                v = 1.0
            px[y * size + x] = int(200 if v > 0 else 40)
    return _png_gray(size, size, bytes(px))


def _healthz() -> dict:
    with urllib.request.urlopen(URL.rstrip("/") + "/healthz", timeout=8) as r:
        return json.load(r)


@pytest.fixture(scope="module")
def registry() -> ModelRegistry:
    """Approve exactly the models the live sidecar reports - mirrors how the
    operator registers the deployed build after verifying it. Extraction and
    matching have distinct model IDs (same jar, same hash) because the
    registry authorises one purpose per model_id."""
    h = _healthz()
    reg = ModelRegistry()
    report = ("SourceAFIS FVC-onGoing public results (vendor-reported), "
              "https://sourceafis.machinezoo.com/")
    reg.approve(ModelCard(h["model_id"], h["model_sha256"],
                          "fingerprint_extraction", True, report,
                          "conformance-suite", "2027-12-31"))
    reg.approve(ModelCard(h["matcher_model_id"], h["model_sha256"],
                          "fingerprint_matching", True, report,
                          "conformance-suite", "2027-12-31"))
    return reg


@pytest.fixture(scope="module")
def sidecar(registry: ModelRegistry) -> FingerprintSidecar:
    return FingerprintSidecar(URL, KEY, registry)


def test_healthz_reports_model_identity():
    h = _healthz()
    assert h["status"] == "ok"
    assert h["model_id"].startswith("sourceafis")
    assert len(h["model_sha256"]) == 64
    assert "score_mapping" in h


def test_analyse_returns_contract_fields(sidecar: FingerprintSidecar):
    analysis = sidecar.analyse(synthetic_fingerprint(), "conf-chal-1")
    assert analysis.sample.template  # opaque, non-empty
    assert analysis.sample.quality.minutiae_count >= 0
    assert 0.0 <= analysis.sample.quality.quality_score <= 1.0
    assert analysis.pad is None  # sidecar must never synthesise PAD


def test_same_image_scores_higher_than_different(sidecar: FingerprintSidecar):
    a1 = sidecar.analyse(synthetic_fingerprint(seed=7), "conf-chal-2")
    a2 = sidecar.analyse(synthetic_fingerprint(seed=7), "conf-chal-3")
    b = sidecar.analyse(synthetic_fingerprint(seed=23), "conf-chal-4")
    same = sidecar.compare(a1.sample.template, a2.sample.template)
    diff = sidecar.compare(a1.sample.template, b.sample.template)
    assert 0.0 <= same.score <= 1.0 and 0.0 <= diff.score <= 1.0
    assert same.score >= diff.score  # ordering only; accuracy is FP-006's job


def test_unauthenticated_request_rejected():
    req = urllib.request.Request(
        URL.rstrip("/") + "/v1/analyse",
        data=json.dumps({"image_b64": base64.b64encode(b"x").decode(),
                         "challenge_id": "c", "retain_image": False}).encode(),
        method="POST", headers={"Content-Type": "application/json"})
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(req, timeout=8)
    assert e.value.code == 401


def test_retain_image_refused(sidecar: FingerprintSidecar):
    req = urllib.request.Request(
        URL.rstrip("/") + "/v1/analyse",
        data=json.dumps({"image_b64": base64.b64encode(synthetic_fingerprint()).decode(),
                         "challenge_id": "c", "retain_image": True}).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"})
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(req, timeout=8)
    assert e.value.code == 400
