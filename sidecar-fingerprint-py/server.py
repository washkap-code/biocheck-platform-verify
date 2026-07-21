"""
HTTP service for the BioCheck Python fingerprint sidecar.

Implements the exact same wire contract as the (unbuilt) Java/SourceAFIS
sidecar's Main.java, so `biocheck_engine/providers/fingerprint.py` works
against this service unmodified — point VERIFY_CORE_FP_SIDECAR_URL at it.

  GET  /healthz
  POST /v1/analyse  {image_b64, challenge_id, retain_image:false}
  POST /v1/compare  {template_a_b64, template_b_b64}

Same safety rules as the Java version:
  - Bearer auth required on /v1/*, key from FP_SIDECAR_API_KEY (fails to
    start without it — refuses to run unauthenticated, same as Main.java).
  - retain_image=true is refused.
  - Images/templates are processed in memory only; nothing is written to
    disk or logged, ever — not even on error paths.
  - model_id / model_sha256 pin the exact deployed algorithm source (hash
    of matcher.py), so the model registry can gate on it exactly like the
    Java sidecar's jar-hash pinning.
  - pad is always null: no presentation-attack detection exists here (see
    matcher.py docstring for why this can't be produced in software).
"""
from __future__ import annotations

import base64
import hmac
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from matcher import (
    MATCHER_MODEL_ID,
    MODEL_ID,
    compare_templates,
    deserialise_template,
    extract_minutiae,
    model_sha256,
    serialise_template,
)

MAX_BODY = 6 * 1024 * 1024
MAX_CAPTURE = 4 * 1024 * 1024
MAX_TEMPLATE = 64 * 1024

_MODEL_SHA256 = model_sha256()


def _err(code: str) -> bytes:
    return json.dumps({"error": code}).encode()


class Handler(BaseHTTPRequestHandler):
    server_version = "biocheck-fp-py/1"

    def log_message(self, fmt, *args):  # silence default stderr logging of paths
        pass

    def _send(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self) -> bool:
        expected = "Bearer " + os.environ["FP_SIDECAR_API_KEY"]
        got = self.headers.get("Authorization", "")
        return hmac.compare_digest(got, expected)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY:
            raise ValueError("payload_too_large")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        if self.path != "/healthz":
            self._send(404, _err("not_found"))
            return
        self._send(200, json.dumps({
            "status": "ok",
            "model_id": MODEL_ID,
            "matcher_model_id": MATCHER_MODEL_ID,
            "model_sha256": _MODEL_SHA256,
            "score_mapping": "Dice-style minutiae-overlap coefficient under best-found rigid "
                             "alignment; NOT calibrated against any external FMR/FNMR standard.",
            "quality_mapping": "score = min(1, minutiae_count / 40) (transparent proxy, not NFIQ2)",
            "engine": "classical crossing-number minutiae extraction + alignment matching "
                      "(numpy/OpenCV/scikit-image) — not SourceAFIS, not a learned model.",
        }).encode())

    def do_POST(self):
        if self.path not in ("/v1/analyse", "/v1/compare"):
            self._send(404, _err("not_found"))
            return
        try:
            if not self._authed():
                self._send(401, _err("unauthorised"))
                return
            body = self._read_body()
            if self.path == "/v1/analyse":
                self._analyse(body)
            else:
                self._compare(body)
        except ValueError as exc:
            self._send(400, _err(str(exc) or "bad_request"))
        except Exception:
            # never leak internals or biometric data in errors
            self._send(500, _err("internal_error"))

    def _analyse(self, body: dict) -> None:
        if body.get("retain_image", False):
            raise ValueError("retain_image_not_supported")
        b64 = body.get("image_b64")
        if not b64:
            raise ValueError("image_b64_required")
        try:
            image = base64.b64decode(b64, validate=True)
        except Exception:
            raise ValueError("image_b64_invalid")
        if not image or len(image) > MAX_CAPTURE:
            raise ValueError("image_size_invalid")

        try:
            minutiae = extract_minutiae(image)
        except ValueError as exc:
            self._send(422, _err(str(exc)))
            return
        template = serialise_template(minutiae)
        if len(template) > MAX_TEMPLATE:
            self._send(422, _err("template_too_large"))
            return

        quality_score = min(1.0, len(minutiae) / 40.0)
        self._send(200, json.dumps({
            "template_b64": base64.b64encode(template).decode(),
            "model_id": MODEL_ID,
            "model_sha256": _MODEL_SHA256,
            "quality": {
                "finger_detected": len(minutiae) > 0,
                "score": quality_score,
                "minutiae_count": len(minutiae),
            },
            "pad": None,  # never synthesised — see matcher.py
        }).encode())
        # `image`, `minutiae`, `template` go out of scope here; nothing persisted.

    def _compare(self, body: dict) -> None:
        def decode(field: str) -> bytes:
            b64 = body.get(field)
            if not b64:
                raise ValueError(f"{field}_required")
            try:
                t = base64.b64decode(b64, validate=True)
            except Exception:
                raise ValueError(f"{field}_invalid")
            if not t or len(t) > MAX_TEMPLATE:
                raise ValueError(f"{field}_size_invalid")
            return t

        raw_a, raw_b = decode("template_a_b64"), decode("template_b_b64")
        try:
            a, b = deserialise_template(raw_a), deserialise_template(raw_b)
        except Exception:
            self._send(422, _err("template_undecodable"))
            return

        score = compare_templates(a, b)
        self._send(200, json.dumps({
            "score": score,
            "matcher_model_id": MATCHER_MODEL_ID,
            "matcher_model_sha256": _MODEL_SHA256,
        }).encode())


def make_server(port: int = 0) -> ThreadingHTTPServer:
    if not os.environ.get("FP_SIDECAR_API_KEY"):
        raise SystemExit("FP_SIDECAR_API_KEY is required; refusing to start without auth.")
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    port = int(os.environ.get("FP_SIDECAR_PORT", "8081"))
    srv = make_server(port)
    print(f"fp-sidecar-py listening on :{srv.server_address[1]} model={MODEL_ID} sha256={_MODEL_SHA256}",
          file=sys.stderr)
    srv.serve_forever()
