# BioCheck build status

## 21 Jul 2026 — Fingerprint: real matching software built, run, verified end-to-end (not enterprise-grade)

Direct answer to "can the platform verify fingerprints at an enterprise-grade
level": **no.** That needs real scanner hardware, PAD, calibration on a real
dataset, and independent evaluation — none producible in a software sandbox.
What this session did close: the fingerprint *matching software* went from
"authored, never compiled or run" (Java/SourceAFIS, blocked here by no root +
network-allowlisted Maven Central/Adoptium) to a working Python alternative
(`sidecar-fingerprint-py/`) — compiled (trivially, it's Python), running,
passing its own 15-check conformance suite, passing the engine's own
previously-always-skipped conformance suite (5/5), and verified end-to-end
through the real FastAPI facade (enrol → encrypted template → compare, correct
same/different-finger ordering, correct single-use capture_ref rejection).
Full detail, all caveats, and the "what's still needed" list:
`docs/FINGERPRINT_BUILD_STATUS.md` and `sidecar-fingerprint-py/README.md`.
Nothing here upgrades the capability past **Prototype**.

## Phase log

### Prompt 0 — Discovery and audit (14 Jul 2026) ✅
- v0.1/v0.3 engine packages reviewed; v0.3 adopted as canonical baseline; 8/8 Python tests pass.
- Created `docs/BASELINE_AUDIT.md`, `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`.
- Decisions taken: D1 keep Python engine as private verify-core; D2 scaffold platform fresh on approved brand (marketing-site reference preserved at `platform/_site_reference_dump.txt`); D3 sidecar build attempted in-workspace.

### Prompt 1 — Enterprise foundation (14 Jul 2026) ✅
- `platform/`: Next.js App Router + TypeScript, PostgreSQL migrations (PGlite for dev/tests, node-postgres for production).
- Tenancy: organisation → workspace → project → sandbox/production environments; strict server-side membership validation.
- Single policy layer (`authz/policy.ts`), 9 roles, MFA-required set.
- Auth: scrypt passwords + policy, verified email, lockout (5×/15 min), rotating hashed sessions, TOTP MFA + recovery codes, invitations, SSO placeholder, IP allow-list schema.
- Scoped API keys per project/environment, secret shown once, denials audited.
- Append-only audit: DB triggers + hash chain (same construction as verify-core) + write-time redaction guard; role-guarded viewer at `/admin/audit` with filters and CSV export.
- Fake-only seeds. Docs: `SECURITY_BASELINE.md`, README setup, `.env.example`.
- **Verification: 20/20 vitest (isolation, roles, scopes, audit chain, auth) + tsc clean + seed dry-run OK; engine 8/8.**

### D3 — SeetaFace6 native build ⛔ blocked by infrastructure
Attempted in this workspace: background processes are terminated between tool calls and execution is capped at ~45 s, so the C++ toolchain build cannot complete here (consistent with `docs/SEETAFACE6_BUILD_STATUS.md`). Owner: Washington, on a Linux builder (Ubuntu 22.04/24.04) using the documented reproducible steps + `native-patches/0001-tennis-gcc13-cstdlib.patch`. Not a blocker for Prompts 2–6.

### Prompt 2 — Verification core, consent, capture sessions (14 Jul 2026) ✅
- Migration `0002_verification.sql`: subjects, consent_receipts, immutable verification_policies (DB-trigger enforced), one-use nonce-bound capture_sessions, reference_templates (opaque ciphertext only), verification_attempts, review_cases, persistent model_registry, webhook endpoints/deliveries, idempotency_keys.
- Provider contract (`analyseCapture`/`createTemplate`/`compareTemplates`): deterministic FakeProvider (refuses to instantiate in production) + VerifyCoreProvider (HTTPS-only outside dev, strict timeout, fail-closed, no body logging). Platform never sees plaintext embeddings.
- Decision policy mirrors `biocheck_engine/policy.py`; thresholds only from approved policy versions; machine-readable reason codes + human-safe messages.
- Fail-closed mapping: liveness failure/missing reference/withdrawn consent ⇒ reject; poor quality/ambiguous similarity/unknown or changed model hash/provider outage ⇒ review. Never silent approval.
- `/v1` API: capture-sessions, enrolments, verifications (POST/GET), review (human session only — API keys cannot decide reviews), consent withdraw; OpenAPI 3.1 served at `/api/v1/openapi.json`; Idempotency-Key on all creates (replay + conflict semantics).
- Webhooks: HMAC-SHA256 (`v1=<hex>` over `timestamp.body`), event-id dedupe, backoff retries, dead-letter after 6 attempts; HTTPS endpoints only; verification helper published.
- Guided capture flow component: notice/consent → instructions → random active challenge → capture → single-use upload → result; aria-live announcements, reduced-motion respected, zero media retention, no accuracy claims.
- **Verification: 41/41 vitest across both suites + tsc clean; engine 8/8 unchanged.**

### Prompt 3 — Privacy, encryption, retention, security controls (14 Jul 2026) ✅
- Migration `0003_privacy.sql`: tenant_keys (KMS-wrapped DEKs + rotation due dates), evidence_objects (purpose + expiry mandatory), subject_requests, legal_holds, data_residency, transfer_register.
- Envelope encryption: KmsAdapter interface + LocalKmsAdapter (dev-labelled); **production startup refuses the dev adapter/weak keys** (tested). Per-tenant AES-256-GCM with context-bound AAD; DEK rotation keeps old versions decrypt-only.
- Secrets at rest: webhook signing secrets and TOTP seeds now envelope-encrypted (tested: ciphertext in DB, signatures/logins still work). API keys/sessions remain hash-only.
- Evidence: object-storage abstraction, zero-retention default, explicit purpose + future expiry required, ciphertext-only at rest, role-guarded audited access, no public URLs, retention sweep purge (tested).
- Subject rights: export (biometric material excluded by design), deletion (revokes + overwrites template ciphertext, withdraws consents, deletes evidence, blocks future matching), legal hold parks deletion as blocked_legal_hold (all tested). Residency + cross-border transfer register with named approver; no silent data movement.
- Controls: redact-by-default structured logger (no unredacted mode), CSP/security headers + CSRF origin middleware (SameSite=Strict; /v1 Bearer routes exempt by construction), MIME magic-byte upload validation, malware-scan adapter (noop refuses production), sliding-window rate limits with Redis-ready store seam, abuse signal.
- Security dashboard `/admin/security`: key rotation due, active policies, model approval expiry, webhook health, high-risk audit events, open reviews, blocked deletions — aggregates only.
- Docs: PRIVACY_AND_RETENTION.md, INCIDENT_RESPONSE.md, DPIA_TEMPLATE.md.
- **Verification: 58/58 vitest (incl. leakage proofs: capture marker scanned across every table; logger redaction) + tsc clean; engine 8/8 unchanged.**

### Prompt 4 — Document verification, review operations, fraud controls (14 Jul 2026) ✅
- Migration `0004_documents.sql`: document_checks (staged results, masked fields only), review_cases risk/SLA/dual-control columns, org_settings (explicit liveness-exception switch, default OFF), device_attestations, risk_signals.
- DocumentVerificationProvider contract with six separate stages (capture quality, classification, OCR/MRZ, expiry, tamper, portrait extraction). SyntheticDocumentProvider for tests/dev only — refuses production, validates no real documents, and the copy says so. Full document numbers are masked at the service boundary and verified never to persist anywhere (tested across tables). Broad audit records carry outcomes only — no doc numbers, masked or otherwise.
- Review operations: queue ordered risk → SLA → age with filters; dual control for high-risk cases (first reviewer records intent, self-confirmation refused, different second reviewer decides — all audited); confirmed liveness failures are final unless the tenant explicitly enables allow_liveness_exception, and even then escalation opens a HIGH-risk dual-control case; capture-quality feedback loop with safe end-user retry tips; reviewer console at `/admin/reviews`.
- Fraud: DeviceAttestationAdapter (noop refuses production), velocity anomaly signals, duplicate-capture detection (truncated hash only), risk_signals guarded by the same redaction rules as audit. High-severity signals downgrade approvals to review — never auto-reject, never protected-trait inference.
- **Verification: 73/73 vitest (41 + 32 across four suites) + tsc clean; engine 8/8 unchanged.**

### Prompt 5 — Customer console, developer platform, marketing site (14 Jul 2026) ✅
- **Marketing site restored from the approved reference** (recovered dump of the previous build): homepage, request-demo, Navbar/Footer/Logo components, navigation, Tailwind theme with the exact Concept 1 palette/typography — used verbatim, no redesign. Lives in the `(marketing)` route group; console/admin routes are deliberately outside it. ⚠️ The three approved logo SVGs must be copied from the brand kit into `platform/public/brand/` (README placed there; kit ZIP not attached this session — code references the correct filenames).
- Organisation dashboard `/console`: live aggregates (volumes, approval/review/reject rates, daily bars, capture-quality issues, webhook health, active policy + model versions, pending/overdue reviews). No static charts; empty/error states handled.
- Project management `/console/projects`: sandbox/production separation, scoped API keys with one-time secret flash (tenant-scoped read-and-burn), webhook endpoint setup (secret shown once), per-environment policy activation (policies:approve), org settings (liveness exception + review SLA) — all via policy-layer-guarded server actions with audit events.
- Developer portal `/developers`: rendered from the live OpenAPI document (single source of truth), TS + Python quick starts with redacted examples, webhook signature verification sample, idempotency guidance, sandbox test personas (simulation clearly labelled).
- Platform super-admin `/admin/platform`: tenant list, model-registry governance (approve with SHA-256 + independent report + expiry; revoke fails verifications closed to review), system health, support impersonation requiring a written reason and always audited. platform_security_admin gets read-only.
- Housekeeping: relative imports normalised (extensionless) so `next build` works; **full production build passes** (Google Fonts fetch requires network — unavailable in this sandbox only).
- **Verification: 82/82 vitest (50 + 32, incl. the 9-step tenant-journey e2e: onboarding → MFA login → key → webhook → enrolment → verification → review completion → dashboard → isolation) + tsc clean + next build OK.**

### Prompt 6 — Reliability, observability, release engineering (14 Jul 2026) ✅
- Config: `validateConfig()` (zod) with four environments; staging/production refuse missing DATABASE_URL/REDIS_URL/IP_HASH_SALT, PGlite, non-HTTPS verify-core; production additionally refuses an env master key (KMS only). All refusal paths tested.
- Docker Compose: app, worker, Postgres 16, Redis 7, contract-test fake sidecar (refuses production, serves the exact verify-core wire contract), optional MinIO profile. Multi-stage Dockerfile with non-root production runner. Secrets only via `.env` (compose fails loudly if unset).
- Job framework (migration `0005_jobs.sql`): Postgres-backed, atomic claim, dedupe-key idempotent scheduling, 1/5/15/60/240-min backoff, dead-letter with sanitised errors, health + retry visibility. Worker loop with graceful shutdown.
- Maintenance jobs (all idempotent, tested): webhooks.deliver (1 min), retention.purge (evidence expiry + stale capture sessions + old idempotency keys, 15 min), audit.export (WORM JSONL segments to object storage with chain-head hash + high-water mark, hourly), keys.rotation_reminder (daily), models.expiry_alert (daily; expires models, notifies via model.status_changed webhooks — verifications fail closed to review).
- Observability: `/api/health` + `/api/ready` (binary, no sensitive data), metrics abstraction (counters/p50/p95 behind a pluggable sink), request-correlation-id resolution (echo valid inbound / mint).
- CI (`.github/workflows/ci.yml`): typecheck, full platform test suite, empty-DB migration check, production build, Python engine tests, gitleaks secret scan, npm audit (critical blocks) + OSV scan — release artifact (image digest) built only when every gate passes; deployment stays manual.
- Docs: OPERATIONS_RUNBOOK.md (backup/restore drill, **RPO ≤ 15 min / RTO ≤ 4 h**, migration strategy, job ops, common incidents), DEPLOYMENT.md, PRODUCTION_RELEASE_CHECKLIST.md (named human approvals incl. model-hash attestation, pilot report, pen test, DPIA).
- **Exact results this phase: platform 94/94 vitest (20+21+17+15+9+12 across six suites), engine 8/8 unittest, tsc clean, next build passing.**
- Remaining blockers (unchanged, external): SeetaFace6 sidecar native build on a real Linux machine; verify-core FastAPI facade (G1); approved logo SVGs into `public/brand/`; production KMS choice.

### Prompt 7 — Final security verification & controlled-pilot readiness (14 Jul 2026) ✅
- Adversarial suite (`adversarial.test.ts`, **20 scenarios, all contained**): cross-tenant access (verifications/sessions/audit/reviews/subject-ref collision), API-key scope escalation + tampered/truncated/revoked keys, capture-session replay + expiry reuse, webhook signature replay/stale/tamper/wrong-secret, model-hash + purpose swap + mid-flight revocation → REVIEW, liveness failure with matching face, exception-path abuse (disabled by default), missing/withdrawn consent, subject deletion + cross-tenant deletion, reviewer cross-org + privilege abuse, raw-biometric leakage across 12 tables + logs, audit-chain integrity, login brute-force lockout.
- One finding during the review: A7.2 assertion was wrong (cross-tenant deletion is contained because operations are tenant-scoped, not because it errors on a shared ref) — corrected the test to assert isolation directly; no code change needed. Targeted fix only, no cosmetic rewrites.
- Docs: PILOT_READINESS_REPORT.md (evidence table per scenario, acceptance-criteria status, residual risks, go/no-go), KNOWN_LIMITATIONS.md (not certified; accuracy/PAD unmeasured; scope boundaries; deployment gaps), BUILD_HANDOVER.md (architecture, endpoints, 5 migrations, roles, env vars, setup, results, the 8 outstanding human approvals). Pilot-only config `testing/pilot.env.example` + pseudonymised import template `testing/results_template.csv` (validated against `summarise_pilot_results.py`).
- **Final results: platform 114/114 vitest (7 suites) + engine 8/8 + tsc clean + next build passing + 5/5 migrations apply.**

### Fingerprint contract layer (15 Jul 2026) ✅
- Modality added end-to-end, mirroring the face architecture, fail-closed everywhere. **No real scanner, extractor or matcher exists** — see `docs/FINGERPRINT_BUILD_STATUS.md` for the honest status and the owner build list.
- Engine: `FingerprintVerificationPolicy` (PAD-required approval cap — strong match without live PAD ⇒ REVIEW, failed PAD ⇒ REJECT), `providers/fingerprint.py` sidecar wire contract (registry gates for `fingerprint_extraction`/`fingerprint_pad`/`fingerprint_matching`; compare delegated to the sidecar), facade endpoints `/v1/fingerprint/{analyse,templates,compare}` with separate AAD crypto context (face↔fingerprint ciphertext cross-replay impossible) and 503 fail-closed when unconfigured; dev fixture adapter (refuses production).
- Platform: migration `0006_fingerprint.sql` (modality columns + immutable `fingerprint_policies` + `active_fp_policy_id`/`fp_policy_id`), `FingerprintProvider` contract on both providers, `decideFingerprint` mirror, `enrolFingerprint`/`verifyFingerprint`, modality-bound capture sessions (mismatch ⇒ 409), `/v1` routes accept `modality`, OpenAPI updated.
- Approved Concept 1 logo SVGs copied into `platform/public/brand/` (handover item #4 cleared).
- **Verification: engine 47/47 (24 new) · platform 133/133 vitest (19 new, incl. cross-modality isolation, PAD cap, revoked-matcher → REVIEW, 503 → REVIEW, ciphertext leakage scan) · tsc clean · 6/6 migrations apply.**

### Phase 6 — Lead capture + Supabase schema sync (15 Jul 2026) ✅
- Supabase project `biocheck-platform-verify` (correct org, reconnected connector): fingerprint schema applied as `0007_fingerprint` (with RLS), lead capture as `0008_demo_requests`; app-level `_migrations` bookkeeping created for 0001–0007 so the platform's migrate runner is consistent with the live database.
- Repo migration `0007_demo_requests.sql`: minimal-PII `demo_requests` table (explicit consent mandatory, IP only as salted hash, status workflow).
- `src/server/leads/service.ts` (validation, consent gate, control-char stripping, listing without ip_hash) + public rate-limited honeypot-protected `/api/demo-requests` route + real form on `/request-demo` (replaces the mailto interim, D-009). Success state uses cyan — green stays reserved for successful verification.
- **Verification: leads 6/6 vitest, tsc clean, 7/7 migrations apply under PGlite; Supabase schema checks pass.**

## Status: all 8 prompts complete
The build is in controlled-pilot posture. Production remains manually gated behind PRODUCTION_RELEASE_CHECKLIST.md.

## Outstanding human approvals / external actions (from BUILD_HANDOVER.md)
1. Build SeetaFace6 sidecar on an isolated Linux builder; record hashes/compiler/OS digest.
2. Implement verify-core FastAPI facade (platform client + contract done).
3. Configure production KMS/HSM; register model hashes in a test-only registry.
4. Drop approved Concept 1 logo SVGs into `platform/public/brand/`.
5. Independent penetration test (pre-production).
6. Approved model cards (licence, independent 1:1 + PAD reports, demographics, calibration).
7. Signed controlled-pilot report (`testing/PILOT_PROTOCOL.md`).
8. Per-tenant DPIA; named release approver; marketing/claims check.
