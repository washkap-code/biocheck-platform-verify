"""
Live-service conformance tests for the Python fingerprint sidecar.

Mirrors the intent of `tests/test_fp_sidecar_conformance.py` written for the
Java sidecar (contract fields, score ordering, auth required, retain_image
refused, health identity) — except these actually run, against a real
running instance of this service, because this one is compiled/runnable in
this environment and the Java one is not.

Test fingerprints are procedurally generated ridge-flow images with a single
loop-type orientation singularity (a standard simplified synthetic-
fingerprint technique), not real biometric captures. This validates the
pipeline's *behaviour* (extraction produces plausible minutiae, matching
correctly discriminates "same finger, different capture" from "different
finger", the transport/contract/auth rules hold) — it is explicitly NOT a
biometric accuracy/FMR/FNMR benchmark, which would require a real, IRB/
consent-appropriate fingerprint dataset this environment has no access to.

Run: FP_SIDECAR_API_KEY=test-key python3 test_conformance.py
"""
from __future__ import annotations

import base64
import json
import math
import os
import threading
import time
import urllib.error
import urllib.request

import cv2
import numpy as np

os.environ.setdefault("FP_SIDECAR_API_KEY", "test-key")
API_KEY = os.environ["FP_SIDECAR_API_KEY"]

from server import make_server  # noqa: E402  (env var must be set first)


def synth_fingerprint(seed: int, size: int = 220, core=None, freq: float = 0.13,
                       rot: float = 0.0, shift=(0, 0), noise: float = 0.04) -> bytes:
    """Procedural loop-type ridge pattern with a singular 'core' point."""
    rng = np.random.default_rng(seed)
    cx, cy = core or (size * 0.5, size * 0.5)
    cx += shift[0]
    cy += shift[1]
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float64)
    dx, dy = xs - cx, ys - cy
    theta_s = np.arctan2(dy, dx)
    phi = 0.5 * theta_s + math.pi / 2 + rot
    phase = freq * (dx * np.cos(phi) + dy * np.sin(phi))
    ridges = np.cos(2 * np.pi * phase)
    img = 128 + 105 * ridges
    img = img + rng.normal(0, noise * 255, size=(size, size))
    # finite "finger pad" vignette so there's a real foreground/background boundary
    yy, xx = np.mgrid[0:size, 0:size]
    r = np.sqrt((xx - size / 2) ** 2 + (yy - size / 2) ** 2)
    img = np.where(r > size * 0.44, 210 + rng.normal(0, 3, size=img.shape), img)
    img = np.clip(img, 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


class Client:
    def __init__(self, base: str, key: str | None):
        self.base = base
        self.key = key

    def _req(self, method: str, path: str, body: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.key is not None:
            req.add_header("Authorization", f"Bearer {self.key}")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def health(self):
        return self._req("GET", "/healthz")

    def analyse(self, image_bytes: bytes, retain_image: bool = False):
        return self._req("POST", "/v1/analyse", {
            "image_b64": base64.b64encode(image_bytes).decode(),
            "challenge_id": "test",
            "retain_image": retain_image,
        })

    def compare(self, tpl_a_b64: str, tpl_b_b64: str):
        return self._req("POST", "/v1/compare", {
            "template_a_b64": tpl_a_b64,
            "template_b_b64": tpl_b_b64,
        })


def run() -> int:
    srv = make_server(0)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    time.sleep(0.2)
    base = f"http://127.0.0.1:{port}"
    client = Client(base, API_KEY)
    no_auth = Client(base, None)
    wrong_auth = Client(base, "not-the-key")

    failures: list[str] = []

    def check(name: str, cond: bool, detail: str = ""):
        status = "PASS" if cond else "FAIL"
        print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))
        if not cond:
            failures.append(name)

    # 1. health identity
    status, body = client.health()
    check("health returns 200", status == 200, f"status={status}")
    check("health exposes model_id/model_sha256/matcher_model_id", {
        "model_id", "matcher_model_id", "model_sha256", "score_mapping", "quality_mapping",
    }.issubset(body.keys()), f"keys={sorted(body.keys())}")

    # 2. auth required
    status, body = no_auth.analyse(synth_fingerprint(seed=1))
    check("analyse without auth -> 401", status == 401, f"status={status} body={body}")
    status, body = wrong_auth.analyse(synth_fingerprint(seed=1))
    check("analyse with wrong key -> 401", status == 401, f"status={status} body={body}")

    # 3. retain_image refused
    status, body = client.analyse(synth_fingerprint(seed=1), retain_image=True)
    check("retain_image=true refused -> 400", status == 400 and body.get("error") == "retain_image_not_supported",
          f"status={status} body={body}")

    # 4. analyse a plausible fingerprint-like image
    img_a1 = synth_fingerprint(seed=42, core=(100, 90), freq=0.14)
    status, a1 = client.analyse(img_a1)
    check("analyse same-finger capture 1 -> 200", status == 200, f"status={status} body={a1}")
    minutiae_a1 = a1.get("quality", {}).get("minutiae_count", 0)
    check("analyse extracts a non-trivial minutiae count", minutiae_a1 >= 5, f"minutiae_count={minutiae_a1}")
    check("model_id/model_sha256 present in analyse response",
          bool(a1.get("model_id")) and bool(a1.get("model_sha256")))
    check("pad is null (no PAD available)", a1.get("pad") is None)

    # 5. same finger, second "capture" (shifted + rotated + independent noise)
    img_a2 = synth_fingerprint(seed=43, core=(100, 90), freq=0.14, shift=(6, -4), rot=math.radians(8))
    status, a2 = client.analyse(img_a2)
    check("analyse same-finger capture 2 -> 200", status == 200, f"status={status}")

    # 6. a genuinely different finger (different core + orientation + frequency)
    img_b = synth_fingerprint(seed=99, core=(60, 150), freq=0.19, rot=math.radians(50))
    status, b1 = client.analyse(img_b)
    check("analyse different-finger -> 200", status == 200, f"status={status}")

    # 7. compare: same finger should score meaningfully higher than different finger
    status, same_cmp = client.compare(a1["template_b64"], a2["template_b64"])
    check("compare same-finger -> 200", status == 200, f"status={status} body={same_cmp}")
    same_score = same_cmp.get("score", -1)

    status, diff_cmp = client.compare(a1["template_b64"], b1["template_b64"])
    check("compare different-finger -> 200", status == 200, f"status={status} body={diff_cmp}")
    diff_score = diff_cmp.get("score", -1)

    check("scores are within [0,1]", 0.0 <= same_score <= 1.0 and 0.0 <= diff_score <= 1.0,
          f"same={same_score} diff={diff_score}")
    check("same-finger score > different-finger score", same_score > diff_score,
          f"same={same_score} diff={diff_score}")
    check("matcher_model_id/model_sha256 present in compare response",
          bool(same_cmp.get("matcher_model_id")) and bool(same_cmp.get("matcher_model_sha256")))

    # 8. self-comparison should score very high (near-identity alignment)
    status, self_cmp = client.compare(a1["template_b64"], a1["template_b64"])
    check("self-compare score is high", self_cmp.get("score", 0) > 0.9, f"self_score={self_cmp.get('score')}")

    print()
    print(f"same-finger score={same_score:.3f}  different-finger score={diff_score:.3f}  "
          f"self-compare={self_cmp.get('score'):.3f}")
    print(f"minutiae counts: capture1={minutiae_a1}, capture2={a2.get('quality',{}).get('minutiae_count')}, "
          f"different-finger={b1.get('quality',{}).get('minutiae_count')}")
    print()
    if failures:
        print(f"{len(failures)} FAILURE(S): {failures}")
        return 1
    print("ALL CONFORMANCE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
