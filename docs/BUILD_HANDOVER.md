# Build handover — BioCheck platform

A concise operator's map of what was built (Prompts 0–7) and exactly what human approvals remain. Deployment is manually gated; nothing here authorises production.

## Architecture

Two planes (see ARCHITECTURE.md):

- **Public plane** — `platform/`: Next.js App Router + TypeScript, PostgreSQL. Holds tenancy, identity, the single authorization layer, consent, capture sessions, verification decisions (scores/reasons only), reviews, webhooks, audit chain, console, developer portal, marketing site. Never sees plaintext biometrics.
- **Private plane** — `biocheck_engine/` (Python, tested) = verify-core: policy, encrypted template vault, model-registry gate, audit emitter, in front of the mTLS SeetaFace6 sidecar (built externally). The platform reaches it through the `VerifyCoreProvider` client; the fake provider/sidecar are dev-and-test only and refuse production.

Repository shape: engine at the repo root; platform under `platform/`; governance and ops docs under `docs/`; pilot materials under `testing/`; CI in `.github/workflows/ci.yml`; local stack in `docker-compose.yml`.

## Endpoints

Public API (`/v1`, API-key Bearer auth, idempotency on creates, OpenAPI at `/api/v1/openapi.json`):
`POST /v1/capture-sessions`, `POST /v1/subjects/:subjectRef/enrolments`, `POST /v1/verifications`, `GET /v1/verifications/:id`, `POST /v1/verifications/:id/review` (human session only), `POST /v1/consents/:id/withdraw`.

Operational: `GET /api/health` (liveness), `GET /api/ready` (readiness), `GET /api/admin/audit/export` (role-guarded CSV).

Console/admin pages: `/console`, `/console/projects`, `/admin/audit`, `/admin/security`, `/admin/reviews`, `/admin/platform`. Marketing: `/`, `/request-demo`, `/developers`.

## Database (5 migrations)

- `0001_init` — organisations, workspaces, projects, environments, users, memberships, sessions, recovery_codes, invitations, sso_connections, api_keys, ip_allowlist, audit_events (append-only trigger + hash chain).
- `0002_verification` — subjects, consent_receipts, verification_policies (immutable trigger), capture_sessions, reference_templates (ciphertext only), verification_attempts, review_cases, model_registry, webhook_endpoints/deliveries, idempotency_keys.
- `0003_privacy` — tenant_keys, evidence_objects, subject_requests, legal_holds, data_residency, transfer_register.
- `0004_documents` — document_checks, review_cases dual-control columns, org_settings, device_attestations, risk_signals.
- `0005_jobs` — jobs, audit_exports.

## Roles

Platform: `platform_super_admin`, `platform_security_admin` (read/audit oversight only). Organisation: `organisation_owner`, `organisation_admin`, `compliance_officer`, `integration_developer`, `reviewer`, `analyst`, `read_only`. All checks flow through `src/server/authz/policy.ts`; MFA is mandatory for both platform roles plus owner/admin.

API-key scopes: `verification:create`, `verification:read`, `enrolment:create`, `consent:manage`, `webhook:manage`.

## Environment variables

`APP_ENV` (development|test|staging|production), `DATABASE_URL`, `DB_DRIVER` (dev pglite), `REDIS_URL`, `IP_HASH_SALT`, `VERIFY_CORE_URL`, `VERIFY_CORE_API_KEY`, `OBJECT_STORE_URL`, `BIOCHECK_MASTER_KEY_B64` (dev KMS only — refused in production). Validated at startup by `src/server/config.ts`; staging/production refuse weak config. Template: `platform/.env.example`; pilot: `testing/pilot.env.example`.

## Local setup

```bash
cd platform && cp .env.example .env.local   # fill values
npm install
npm test          # 114 tests
npm run seed      # fake demo data
npm run dev
# or the full stack:
docker compose up  # app, worker, postgres, redis, fake sidecar
```

## Test results (this build)

Platform **114/114** vitest (foundation 20, verification 21, privacy 17, documents 15, e2e 9, operations 12, adversarial 20). Engine **8/8** unittest. tsc clean. `next build` passing. 5/5 migrations apply to an empty DB. Model manifest verification passes for six SeetaFace6 modules on the build host.

## Exact human approvals / actions still required

Engineering / infrastructure (owner: Washington's team):

1. Build the SeetaFace6 sidecar on an isolated Linux builder; record binary hashes, compiler and OS digest (SEETAFACE6_BUILD_STATUS.md).
2. Implement the verify-core FastAPI facade (`/v1/analyse`, `/v1/templates`, `/v1/compare`) — platform client + contract already defined.
3. Configure a production KMS/HSM adapter; register exact model hashes in a test-only registry for the pilot.
4. Drop the approved Concept 1 logo SVGs into `platform/public/brand/`.
5. Run an independent penetration test (before production, not before pilot).

Governance / human sign-off (PRODUCTION_RELEASE_CHECKLIST.md):

6. Approved model cards: licence review, independent 1:1 + PAD test reports, demographic breakdowns, threshold calibration.
7. Signed controlled-pilot report per `testing/PILOT_PROTOCOL.md` (30+ consented adult volunteers; FRR + FAR/APCER proxy via `scripts/summarise_pilot_results.py`).
8. DPIA per launching tenant; named release approver; marketing/claims check.

Until items 1–8 are complete and signed, BioCheck stays in controlled-pilot posture. It is not certified, its accuracy and liveness performance are unmeasured, and no production or high-impact decision should rely on it (KNOWN_LIMITATIONS.md).
