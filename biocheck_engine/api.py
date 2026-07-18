"""verify-core HTTP facade.

Wraps biocheck_engine (policy, model registry, crypto, audit) behind the exact
three-endpoint contract platform/src/server/verification/providers.ts already
speaks to: POST /v1/analyse, /v1/templates, /v1/compare. This process is the
provider boundary referred to throughout the codebase — the platform's Next.js
app never receives a raw embedding, only opaque capture_ref / template_ciphertext
strings and derived metadata (scores, model ids).

Fail-closed, matching the rest of the codebase:
- No face-analysis adapter configured -> refuses to start (never a silent
  fallback to a fake provider).
- Unknown/unapproved model hash -> HTTP 409, never a silent pass.
- capture_ref is single-use and short-lived; expired/reused/unknown -> 409.
- Nothing here ever logs raw image bytes, embeddings or bearer tokens.
"""
from __future__ import annotations

import base64
import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .crypto import EncryptedBlob, decrypt_json, encrypt_json
from .model_registry import ModelCard, ModelRegistry
from .providers.fingerprint import FingerprintAnalysis, FingerprintSidecar
from .providers.seetaface import SeetaFaceAnalysis, SeetaFaceSidecar
from .service import cosine_similarity

# A fixed context string, not a real tenant id: this facade has no tenant
# concept (the wire contract it implements does not pass one — multi-tenant
# isolation is enforced by the platform's own database columns, not by this
# ciphertext). It only binds the ciphertext's AAD to "this facade", so a blob
# can't be silently reinterpreted by a different encryption context.
_TEMPLATE_CRYPTO_CONTEXT = "verify-core-template-v1"
# Separate context so a face template ciphertext can never be replayed into
# the fingerprint compare path or vice versa (AAD mismatch fails decryption).
_FP_TEMPLATE_CRYPTO_CONTEXT = "verify-core-fp-template-v1"

CAPTURE_TTL_SECONDS = 120


@dataclass
class _CaptureRecord:
    embedding: object  # np.ndarray, kept in-process only, never serialised out
    model_id: str
    model_sha256: str
    expires_at: float
    consumed: bool = False


@dataclass
class _FpCaptureRecord:
    template: bytes  # opaque minutiae template, kept in-process only
    model_id: str
    model_sha256: str
    pad_present: bool
    pad_is_live: bool
    expires_at: float
    consumed: bool = False


class _CaptureStore:
    """In-memory, single-process, single-use, short-lived. Fine for one
    verify-core instance; a multi-instance deployment needs a shared store
    (e.g. Redis) instead — flagged in docs/PUSH_AND_DEPLOY.md, not implemented
    here since this facade is meant to be self-contained for now."""

    def __init__(self, prefix: str = "vc") -> None:
        self._prefix = prefix
        self._records: dict[str, _CaptureRecord] = {}

    def put(self, record) -> str:
        self._gc()
        ref = f"{self._prefix}_{uuid.uuid4().hex}"
        self._records[ref] = record
        return ref

    def consume(self, ref: str) -> _CaptureRecord:
        self._gc()
        record = self._records.get(ref)
        if record is None or record.consumed or record.expires_at < time.time():
            self._records.pop(ref, None)
            raise KeyError("capture_ref is invalid, expired or already used")
        record.consumed = True
        return record

    def _gc(self) -> None:
        now = time.time()
        for ref, record in list(self._records.items()):
            if record.consumed or record.expires_at < now:
                self._records.pop(ref, None)


class AnalyseRequest(BaseModel):
    image_b64: str
    challenge_id: str
    retain_image: bool = False


class TemplateRequest(BaseModel):
    capture_ref: str


class CompareRequest(BaseModel):
    template_ciphertext: str
    capture_ref: str


class FpAnalyseRequest(BaseModel):
    image_b64: str
    challenge_id: str
    retain_image: bool = False


def _load_model_registry() -> ModelRegistry:
    registry = ModelRegistry()
    raw = os.environ.get("VERIFY_CORE_APPROVED_MODELS_JSON")
    if raw:
        for entry in json.loads(raw):
            registry.approve(ModelCard(**entry))
    if os.environ.get("VERIFY_CORE_DEV_FIXTURES", "").lower() == "true":
        if os.environ.get("APP_ENV", "").lower() == "production":
            raise RuntimeError("VERIFY_CORE_DEV_FIXTURES must never be enabled when APP_ENV=production.")
        from .dev_fixture_adapter import (
            DEV_FACE_MODEL_ID, DEV_FACE_MODEL_SHA256, DEV_FP_MATCHER_MODEL_ID,
            DEV_FP_MATCHER_MODEL_SHA256, DEV_FP_MODEL_ID, DEV_FP_MODEL_SHA256,
            DEV_FP_PAD_MODEL_ID, DEV_FP_PAD_MODEL_SHA256, DEV_PAD_MODEL_ID, DEV_PAD_MODEL_SHA256,
        )
        registry.approve(ModelCard(DEV_FACE_MODEL_ID, DEV_FACE_MODEL_SHA256, "face_embedding",
                                    True, "DEV-FIXTURE-NOT-A-REAL-EVAL", "dev-fixtures", "2099-01-01"))
        registry.approve(ModelCard(DEV_PAD_MODEL_ID, DEV_PAD_MODEL_SHA256, "passive_pad",
                                    True, "DEV-FIXTURE-NOT-A-REAL-EVAL", "dev-fixtures", "2099-01-01"))
        registry.approve(ModelCard(DEV_FP_MODEL_ID, DEV_FP_MODEL_SHA256, "fingerprint_extraction",
                                    True, "DEV-FIXTURE-NOT-A-REAL-EVAL", "dev-fixtures", "2099-01-01"))
        registry.approve(ModelCard(DEV_FP_PAD_MODEL_ID, DEV_FP_PAD_MODEL_SHA256, "fingerprint_pad",
                                    True, "DEV-FIXTURE-NOT-A-REAL-EVAL", "dev-fixtures", "2099-01-01"))
        registry.approve(ModelCard(DEV_FP_MATCHER_MODEL_ID, DEV_FP_MATCHER_MODEL_SHA256,
                                    "fingerprint_matching",
                                    True, "DEV-FIXTURE-NOT-A-REAL-EVAL", "dev-fixtures", "2099-01-01"))
    return registry


def _load_adapter(registry: ModelRegistry):
    """Explicit config only, never a silent fallback — mirrors
    platform/src/server/api/http.ts's getProvider(). Like the fingerprint
    adapter this may return None: a fingerprint-only deployment is valid and
    every face endpoint then fails closed with 503. create_app() still refuses
    to boot when NO adapter of any modality is configured."""
    sidecar_url = os.environ.get("VERIFY_CORE_SIDECAR_URL")
    if sidecar_url:
        api_key = os.environ.get("VERIFY_CORE_SIDECAR_API_KEY")
        if not api_key:
            raise RuntimeError("VERIFY_CORE_SIDECAR_API_KEY is required when VERIFY_CORE_SIDECAR_URL is set.")
        return SeetaFaceSidecar(sidecar_url, api_key, registry)
    if os.environ.get("VERIFY_CORE_DEV_FIXTURES", "").lower() == "true":
        from .dev_fixture_adapter import DevFixtureAdapter
        return DevFixtureAdapter()
    return None


def _load_fingerprint_adapter(registry: ModelRegistry):
    """Explicit config only. UNLIKE the face adapter this may return None:
    a face-only deployment is valid, and every fingerprint endpoint then
    fails closed with 503 — there is no simulated fallback."""
    sidecar_url = os.environ.get("VERIFY_CORE_FP_SIDECAR_URL")
    if sidecar_url:
        api_key = os.environ.get("VERIFY_CORE_FP_SIDECAR_API_KEY")
        if not api_key:
            raise RuntimeError(
                "VERIFY_CORE_FP_SIDECAR_API_KEY is required when VERIFY_CORE_FP_SIDECAR_URL is set.")
        allow_private = os.environ.get("VERIFY_CORE_FP_PRIVATE_NETWORK", "").lower() == "true"
        return FingerprintSidecar(sidecar_url, api_key, registry,
                                  allow_private_network=allow_private)
    if os.environ.get("VERIFY_CORE_DEV_FIXTURES", "").lower() == "true":
        from .dev_fixture_adapter import DevFingerprintFixtureAdapter
        return DevFingerprintFixtureAdapter()
    return None


def create_app() -> FastAPI:
    registry = _load_model_registry()
    adapter = _load_adapter(registry)
    fp_adapter = _load_fingerprint_adapter(registry)
    if adapter is None and fp_adapter is None:
        raise RuntimeError(
            "No face-analysis adapter configured. Set VERIFY_CORE_SIDECAR_URL (+ "
            "VERIFY_CORE_SIDECAR_API_KEY) for the real SeetaFace6 sidecar, or "
            "VERIFY_CORE_DEV_FIXTURES=true for local development only. "
            "(A fingerprint-only deployment is valid — configure "
            "VERIFY_CORE_FP_SIDECAR_URL — but at least one modality is required.)"
        )
    captures = _CaptureStore()
    fp_captures = _CaptureStore(prefix="vcfp")
    expected_key = os.environ.get("VERIFY_CORE_API_KEY")
    if not expected_key and os.environ.get("APP_ENV", "").lower() == "production":
        raise RuntimeError("VERIFY_CORE_API_KEY must be set when APP_ENV=production.")

    app = FastAPI(title="BioCheck verify-core", docs_url=None, redoc_url=None)

    def require_auth(authorization: Optional[str] = Header(None)) -> None:
        if not expected_key:
            return  # local dev with no key configured
        presented = (authorization or "").removeprefix("Bearer ").strip()
        if not presented or presented != expected_key:
            raise HTTPException(status_code=401, detail="Invalid or missing bearer token.")

    @app.exception_handler(Exception)
    async def _no_leak_handler(_: Request, exc: Exception) -> JSONResponse:
        # Never echo internals, and never let a stray str(exc) carry request
        # content — every raise site below only ever includes safe, static text.
        if isinstance(exc, HTTPException):
            return JSONResponse({"error": exc.detail}, status_code=exc.status_code)
        return JSONResponse({"error": "internal_error"}, status_code=500)

    @app.get("/health")
    async def health() -> dict:
        return {
            "status": "ok",
            "adapter": adapter.__class__.__name__ if adapter else None,
            "fingerprint_adapter": fp_adapter.__class__.__name__ if fp_adapter else None,
        }

    def require_fp_adapter():
        if fp_adapter is None:
            raise HTTPException(
                503, "Fingerprint verification is not configured; failing closed.")
        return fp_adapter

    def require_face_adapter():
        if adapter is None:
            raise HTTPException(
                503, "Face verification is not configured; failing closed.")
        return adapter

    @app.post("/v1/analyse", dependencies=[Depends(require_auth)])
    async def analyse(body: AnalyseRequest) -> dict:
        try:
            image_bytes = base64.b64decode(body.image_b64, validate=True)
        except Exception:
            raise HTTPException(400, "image_b64 is not valid base64.")
        if not image_bytes or len(image_bytes) > 8 * 1024 * 1024:
            raise HTTPException(400, "Capture must be non-empty and below 8 MiB.")
        active_face = require_face_adapter()
        try:
            result: SeetaFaceAnalysis = active_face.analyse(image_bytes, body.challenge_id)
        except PermissionError:
            raise HTTPException(409, "Model is not in the approved registry.")
        except (ValueError, KeyError):
            raise HTTPException(422, "Capture could not be analysed.")
        except RuntimeError:
            raise HTTPException(503, "Face-analysis service unavailable; verification must fail closed.")

        ref = captures.put(_CaptureRecord(
            embedding=result.face.embedding,
            model_id=result.face.model_id,
            model_sha256=result.face.model_sha256,
            expires_at=time.time() + CAPTURE_TTL_SECONDS,
        ))
        q = result.face.quality
        return {
            "capture_ref": ref,
            "quality": {
                "face_detected": q.face_detected,
                "score": q.quality_score,
                "pose_degrees": q.pose_degrees,
                "occlusion_score": q.occlusion_score,
            },
            "passive_pad": {
                "is_live": result.liveness.is_live,
                "score": result.liveness.score,
                "attack_type": result.liveness.attack_type,
                "model_id": result.pad_model_id,
                "model_sha256": result.pad_model_sha256,
            },
            "model_id": result.face.model_id,
            "model_sha256": result.face.model_sha256,
        }

    @app.post("/v1/templates", dependencies=[Depends(require_auth)])
    async def templates(body: TemplateRequest) -> dict:
        try:
            record = captures.consume(body.capture_ref)
        except KeyError:
            raise HTTPException(409, "capture_ref is invalid, expired or already used.")
        blob = encrypt_json(_TEMPLATE_CRYPTO_CONTEXT, {
            "embedding": record.embedding.tolist(),
            "model_id": record.model_id,
            "model_sha256": record.model_sha256,
        })
        ciphertext = f"v1:{blob.nonce_b64}:{blob.ciphertext_b64}"
        return {"template_ciphertext": ciphertext, "model_id": record.model_id, "model_sha256": record.model_sha256}

    @app.post("/v1/compare", dependencies=[Depends(require_auth)])
    async def compare(body: CompareRequest) -> dict:
        try:
            record = captures.consume(body.capture_ref)
        except KeyError:
            raise HTTPException(409, "capture_ref is invalid, expired or already used.")
        try:
            prefix, nonce_b64, ciphertext_b64 = body.template_ciphertext.split(":", 2)
            if prefix != "v1":
                raise ValueError("unsupported template version")
            payload = decrypt_json(_TEMPLATE_CRYPTO_CONTEXT, EncryptedBlob(nonce_b64, ciphertext_b64))
        except Exception:
            raise HTTPException(422, "template_ciphertext is malformed or could not be decrypted.")

        import numpy as np
        reference = np.asarray(payload["embedding"], dtype=np.float32)
        selfie = np.asarray(record.embedding, dtype=np.float32)
        try:
            similarity = cosine_similarity(reference, selfie)
        except ValueError:
            raise HTTPException(422, "Reference and capture embeddings are not comparable.")
        return {"similarity": similarity}

    # ------------------------------------------------------------------
    # Fingerprint endpoints. Same shape as the face contract; comparison is
    # delegated to the sidecar because minutiae matching is not a local
    # vector operation. All fail closed when no adapter is configured.
    # ------------------------------------------------------------------

    @app.post("/v1/fingerprint/analyse", dependencies=[Depends(require_auth)])
    async def fp_analyse(body: FpAnalyseRequest) -> dict:
        active = require_fp_adapter()
        try:
            image_bytes = base64.b64decode(body.image_b64, validate=True)
        except Exception:
            raise HTTPException(400, "image_b64 is not valid base64.")
        if not image_bytes or len(image_bytes) > 4 * 1024 * 1024:
            raise HTTPException(400, "Capture must be non-empty and below 4 MiB.")
        try:
            result = active.analyse(image_bytes, body.challenge_id)
        except PermissionError:
            raise HTTPException(409, "Model is not in the approved registry.")
        except (ValueError, KeyError):
            raise HTTPException(422, "Capture could not be analysed.")
        except RuntimeError:
            raise HTTPException(503, "Fingerprint service unavailable; verification must fail closed.")

        pad = result.pad
        ref = fp_captures.put(_FpCaptureRecord(
            template=result.sample.template,
            model_id=result.sample.model_id,
            model_sha256=result.sample.model_sha256,
            pad_present=pad is not None,
            pad_is_live=bool(pad.is_live) if pad else False,
            expires_at=time.time() + CAPTURE_TTL_SECONDS,
        ))
        q = result.sample.quality
        return {
            "capture_ref": ref,
            "quality": {
                "finger_detected": q.finger_detected,
                "score": q.quality_score,
                "minutiae_count": q.minutiae_count,
            },
            "pad": None if pad is None else {
                "is_live": pad.is_live,
                "score": pad.score,
                "attack_type": pad.attack_type,
                "model_id": pad.model_id,
                "model_sha256": pad.model_sha256,
            },
            "model_id": result.sample.model_id,
            "model_sha256": result.sample.model_sha256,
        }

    @app.post("/v1/fingerprint/templates", dependencies=[Depends(require_auth)])
    async def fp_templates(body: TemplateRequest) -> dict:
        require_fp_adapter()
        try:
            record = fp_captures.consume(body.capture_ref)
        except KeyError:
            raise HTTPException(409, "capture_ref is invalid, expired or already used.")
        blob = encrypt_json(_FP_TEMPLATE_CRYPTO_CONTEXT, {
            "template_b64": base64.b64encode(record.template).decode(),
            "model_id": record.model_id,
            "model_sha256": record.model_sha256,
        })
        ciphertext = f"fp1:{blob.nonce_b64}:{blob.ciphertext_b64}"
        return {"template_ciphertext": ciphertext, "model_id": record.model_id,
                "model_sha256": record.model_sha256}

    @app.post("/v1/fingerprint/compare", dependencies=[Depends(require_auth)])
    async def fp_compare(body: CompareRequest) -> dict:
        active = require_fp_adapter()
        try:
            record = fp_captures.consume(body.capture_ref)
        except KeyError:
            raise HTTPException(409, "capture_ref is invalid, expired or already used.")
        try:
            prefix, nonce_b64, ciphertext_b64 = body.template_ciphertext.split(":", 2)
            if prefix != "fp1":
                raise ValueError("unsupported template version")
            payload = decrypt_json(_FP_TEMPLATE_CRYPTO_CONTEXT, EncryptedBlob(nonce_b64, ciphertext_b64))
            reference = base64.b64decode(payload["template_b64"])
        except Exception:
            raise HTTPException(422, "template_ciphertext is malformed or could not be decrypted.")
        try:
            comparison = active.compare(reference, record.template)
        except PermissionError:
            raise HTTPException(409, "Model is not in the approved registry.")
        except ValueError:
            raise HTTPException(422, "Reference and capture templates are not comparable.")
        except RuntimeError:
            raise HTTPException(503, "Fingerprint service unavailable; verification must fail closed.")
        return {
            "score": comparison.score,
            "matcher_model_id": comparison.matcher_model_id,
            "matcher_model_sha256": comparison.matcher_model_sha256,
            "pad": {"present": record.pad_present, "is_live": record.pad_is_live},
        }

    return app


# `uvicorn biocheck_engine.api:app` entry point. Deliberately unconditional:
# if no adapter is configured this raises immediately at import/startup time
# (fail closed) instead of booting into a broken or silently-fallback state.
app = create_app()
