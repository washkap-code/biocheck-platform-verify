# BioCheck Technologies — Baseline engineering audit (Prompt 0)

Date: 14 July 2026
Auditor: Fable session (resumed BioCheck build)
Scope: everything accessible in this session. No changes deployed. No working functionality discarded.

---

## 0. What is and is not accessible in this session

Accessible and audited:

- `BioCheck_Verify_Engine_v0.1_release.zip` — baseline Python verification core.
- `BioCheck_Verify_Engine_v0.3_SeetaFace6_Verified_Release.zip` — v0.1 plus the SeetaFace6 provider adapter, verified model manifest, native-build patch, pilot protocol and supporting scripts. v0.3 is a strict superset of v0.1; every shared file is identical or extended. **v0.3 is the authoritative baseline** and has been copied to `biocheck-verify/` as the working repo.
- `BioCheck_Fable_Master_Build_Prompts.md` — the delivery plan this audit maps to.
- Project brand direction (approved Concept 1 identity: B-monogram with verification tick and identity-frame corners; Midnight #07111F, Verified Cyan #18D7E8, Verification Green #32E875, Signal Violet #7657FF, Cloud White #F7F9FC; Manrope/Inter/IBM Plex Mono).

Not accessible in this session — stated plainly, per project rules:

- **The Next.js marketing site / console codebase** built in earlier Cowork sessions. Its outputs live in other session folders this session cannot mount. The audit of "current pages/components/API functions" for the web app therefore cannot be performed yet. Re-attach that codebase (zip of the site repo) before Prompt 1 work touches it, or Prompt 1 will scaffold the platform fresh while preserving the approved brand assets.
- **The GENFIN/BioVerify source repository.** Only the public demo URL is known. No code audit has been done and no production capability is inferred from the demo.
- No deployment configuration (Vercel/hosting) is present in this session.

## 1. Current stack, structure, data model

Working repo `biocheck-verify/` (from v0.3):

- Language: Python ≥3.11. Dependencies: `cryptography`, `numpy`, `pydantic`; optional extras `api` (FastAPI/uvicorn) and `onnx` (onnxruntime, OpenCV headless).
- Modules (459 lines total — deliberately small, security-critical core):
  - `types.py` — Decision enum, CaptureQuality, LivenessResult, FaceSample, VerificationResult.
  - `policy.py` — immutable `VerificationPolicy` (quality/pose/occlusion/liveness/similarity thresholds) with a pure `decide()`; fails closed on liveness.
  - `crypto.py` — HKDF per-tenant key derivation from `BIOCHECK_MASTER_KEY_B64`, AES-256-GCM template encryption, canonical-JSON SHA-256 event digest.
  - `vault.py` — in-memory encrypted TemplateVault (explicitly a placeholder for an HSM-backed transactional store).
  - `model_registry.py` — approved-model gate: ID + file SHA-256 + purpose + commercial-licence + independent-report reference; wrong hash/purpose ⇒ PermissionError.
  - `audit.py` — in-memory hash-chained audit log with `verify()`; placeholder for WORM storage.
  - `adapters.py` — provider protocols + `OnnxEmbeddingProvider` (registry-gated ONNX runtime adapter).
  - `providers/seetaface.py` — sidecar HTTP client: HTTPS-only outside localhost, 8 MiB JPEG cap, fail-closed on transport error, requires both recognition and PAD model hashes to be registry-approved, validates embedding shape/finiteness.
  - `service.py` — `VerificationService.enrol/verify`: consent reference required at enrolment, model-version mismatch ⇒ REVIEW, every outcome appended to the audit chain.
- Governance artefacts: `docs/ENTERPRISE_ARCHITECTURE.md`, `MODEL_GOVERNANCE.md`, `CERTIFICATION_ROADMAP.md`, `SEETAFACE6_INTEGRATION.md`, `SEETAFACE6_BUILD_STATUS.md`, `testing/PILOT_PROTOCOL.md`, `model-manifest/seetaface6-official-2026-07-14.json` (six pinned SHA-256s), `native-patches/0001-tennis-gcc13-cstdlib.patch`, `scripts/verify_model_manifest.py`, `scripts/summarise_pilot_results.py`.

Data model: in-memory only. No database, no migrations, no persistence.
Auth: none (library, not a service).
Deployment config: none.

## 2. What works, is incomplete, or is unsafe

Works (verified in this session — `python -m unittest discover -s tests -v`, **8/8 pass**):

- 1:1 approve/review/reject decisioning incl. spoof rejection with matching face, model-mismatch ⇒ REVIEW, other-person rejection.
- Model registry blocks wrong hash and unlicensed models; SeetaFace adapter rejects unknown embedding and PAD models.
- Audit chain verification.

Incomplete:

- **README references `uvicorn biocheck_engine.api:app` but no `api.py` exists.** The HTTP API layer is unwritten. (Gap G1.)
- Vault and audit are in-memory placeholders — no persistence, no WORM export. (G2)
- No tenancy, users, roles, API keys, consent entities, capture sessions, webhooks — all of Prompt 1/2 scope.
- SeetaFace6 sidecar: source and models verified by pinned hashes, but **no native binary exists** — upstream TenniS fails on GCC 13 without the included `<cstdlib>` patch, and the hosted workspace kills long compiles. See "the note" in §5.
- No CI, lint, type-checking config; tests use `unittest`, no coverage of crypto edge cases or vault key-rotation.

Unsafe / must fix before any exposure (none of these are exposed today since nothing is deployed):

- Master key from a plain environment variable (documented as dev-only; production must refuse this — Prompt 3 KMS/HSM adapter).
- `providers/seetaface.py` permits plain HTTP to `localhost` — acceptable for dev, must be environment-gated so production config cannot select it.
- `service.verify()` accepts a caller-supplied `LivenessResult` — trust boundary must move server-side once the API layer exists (the sidecar's PAD result, not client input).
- Audit events include similarity/liveness scores (fine) — confirmed they never include embeddings or images; keep a regression test for this (Prompt 3).
- No rate limiting, idempotency keys, request signing — API-layer scope.

## 3. Security gap summary (mapped)

| Gap | Area | Severity now | Fix phase |
|---|---|---|---|
| G1 | No HTTP API despite README | Doc/feature mismatch | Prompt 2 |
| G2 | In-memory vault/audit | Data loss, no evidence retention | Prompts 1–3 |
| G3 | Env-var master key | Key management | Prompt 3 |
| G4 | No tenancy/authz/API keys | Isolation | Prompt 1 |
| G5 | Client-supplied liveness at library boundary | Spoof risk if misused | Prompt 2 |
| G6 | No rate limits/idempotency/webhook signing | Abuse/replay | Prompts 2, 4 |
| G7 | No CI/secret scan/dependency scan | Release engineering | Prompt 6 |
| G8 | HTTP-to-localhost path not env-gated | Misconfiguration | Prompt 2 |
| G9 | No secrets in repo — verified clean (`.gitignore` excludes vendor/, tools/, testing/results.csv) | — | — |

## 4. Safe migration plan

1. Treat `biocheck-verify/` (v0.3) as the canonical verification core. Do not rewrite it; extend it. Its policy/registry/crypto semantics are correct and tested.
2. The platform (tenancy, consent, capture sessions, console, developer portal) is built per the master prompts as a **Next.js App Router + TypeScript modular monolith** with PostgreSQL and Prisma/Drizzle. The Python core becomes the **private verification service** in front of the SeetaFace6 inference sidecar: platform → verify-core (policy, vault, registry, audit) → SeetaFace6 sidecar. This preserves all tested code and keeps biometrics out of the public app process. (See ARCHITECTURE.md; decision D1.)
3. Approved brand assets are never regenerated. When the site codebase is re-attached, its UI is preserved and re-pointed at real APIs.
4. Nothing deploys until Prompt 7 review and the release checklist pass.

## 5. The note on the main README (flagged as requested)

The v0.3 README's closing note points to `docs/SEETAFACE6_BUILD_STATUS.md`. Its substance: SeetaFace6 source (commit `a32e2fa`, TenniS `ef6c833`) and the six official model files are verified by SHA-256 manifest, but **the native sidecar cannot be compiled in this hosted workspace** — long compiles are force-terminated (infrastructure constraint, not a source/model failure). A GCC 13 compatibility patch is included. **Action required from you:** the sidecar must be built on a designated isolated Linux builder (Ubuntu 22.04/24.04) using the documented reproducible steps, binary hashes recorded, before any pilot. Everything else in Prompts 1–6 can proceed without that binary using the deterministic fake provider and the sidecar contract.

## 6. Phased implementation checklist

- **Prompt 0 (this)** — audit ✅, ARCHITECTURE.md ✅, THREAT_MODEL.md ✅, working repo established ✅.
- **Prompt 1** — tenancy (org/workspace/env/project/API key), roles + single policy layer, auth + MFA, invitations, append-only audit system with viewer, Postgres migrations, isolation tests, SECURITY_BASELINE.md.
- **Prompt 2** — Subject/ConsentReceipt/VerificationPolicy/CaptureSession/ReferenceTemplate/VerificationAttempt/ReviewCase; provider contract (fake + SeetaFace6 sidecar client); model registry persistence; `/v1` API + OpenAPI; idempotency; signed webhooks; guided capture UI.
- **Prompt 3** — envelope encryption + KMS adapter, zero-retention evidence storage, export/deletion workflow, residency register, safe logging, security dashboard, PRIVACY_AND_RETENTION.md, INCIDENT_RESPONSE.md, DPIA template.
- **Prompt 4** — DocumentVerificationProvider (synthetic fixtures only), review-operations console, fraud controls (nonce, session binding, attestation adapter, velocity signals).
- **Prompt 5** — customer console, developer portal from real OpenAPI, super-admin, marketing site alignment (approved brand, no unverified claims).
- **Prompt 6** — Docker Compose stack, env validation, job framework, health/metrics, backup/DR runbook, CI gates, release checklist.
- **Prompt 7** — adversarial review, PILOT_READINESS_REPORT.md, KNOWN_LIMITATIONS.md, pilot-only config, handover. Deployment stays manually gated.

## 7. Decisions required from you

- **D1** — Confirm the two-service shape: TypeScript platform + Python verify-core service (recommended, preserves tested code), versus porting policy/vault/registry to TypeScript inside the monolith (single runtime, but rewrites verified security code).
- **D2** — Re-attach the existing website/console codebase zip so it can be audited and preserved, or confirm Prompt 1 scaffolds fresh.
- **D3** — Who owns the external Linux build of the SeetaFace6 sidecar (per §5), and when.
