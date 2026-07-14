# BioCheck Technologies — Platform architecture

Status: proposed at Prompt 0, to be implemented across Prompts 1–6. Supersedes nothing; extends `ENTERPRISE_ARCHITECTURE.md` (engine-level view) with the full platform view.

## Shape: modular monolith + private verification plane

```
┌────────────────────────────  Public plane  ────────────────────────────┐
│  Next.js App Router + TypeScript (single deployable "platform")        │
│  • Marketing site (approved BioCheck brand)                            │
│  • Customer console, review-ops console, super-admin                   │
│  • Developer portal (generated from OpenAPI)                           │
│  • /v1 REST API (server routes/actions) + webhooks                     │
│  Modules: tenancy | authn/authz policy layer | consent | capture       │
│  sessions | verifications | reviews | webhooks | billing-ready | audit │
└───────────────┬────────────────────────────────────────────────────────┘
                │ mTLS, private network only
┌───────────────▼────────────  Private plane  ───────────────────────────┐
│  verify-core (Python, biocheck_engine — existing tested code)          │
│  policy decide() • encrypted template vault • model registry gate      │
│  • hash-chained audit emitter                                          │
│        │ mTLS, no public ingress, read-only /secure/models             │
│  ┌─────▼──────────────────────────────┐                                │
│  │ SeetaFace6 inference sidecar (C++) │  POST /v1/analyse only         │
│  │ model-hash pinned, no body logging │  (built on external builder)   │
│  └────────────────────────────────────┘                                │
└─────────────────────────────────────────────────────────────────────────┘
Shared infrastructure: PostgreSQL (Prisma/Drizzle migrations) • Redis-compatible
queue/rate-limit abstraction • object-storage abstraction (encrypted evidence,
zero-retention default) • KMS/HSM adapter • structured redacted logging.
```

Local development: Docker Compose runs platform, PostgreSQL, Redis-compatible worker, a deterministic fake inference sidecar (contract-test double) and optional MinIO. Model weights are never in the repository.

## Why this shape (decision D1)

- The Python engine is small (≈460 lines), tested (8/8) and security-reviewed; porting it to TypeScript rewrites exactly the code that must not regress.
- Biometric material (embeddings, template keys) never enters the public app process; the platform holds only opaque references, decisions and reason codes.
- The provider interface (`analyseCapture`, `createTemplate`, `compareTemplates`) lives at the verify-core boundary, so SeetaFace6 can be replaced by another approved provider without any client or customer API change.
- Fail-closed is structural: if the private plane is unreachable, `/v1/verifications` returns a REVIEW/unavailable outcome, never a silent approval.

## Data ownership

- PostgreSQL (platform schema): organisations, workspaces, environments, projects, API keys, users, roles, sessions, consent receipts, verification policies (versioned, immutable), capture sessions, verification attempts (scores + reason codes only), review cases, webhook endpoints/deliveries, audit events (hash-chained), model registry cards, residency/transfer register.
- verify-core storage: encrypted reference templates only (AES-256-GCM, per-tenant keys via HKDF now, KMS/HSM envelope keys from Prompt 3). Templates are never returned to the public plane.
- Object storage: optional evidence media, encrypted, purpose + retention date required, default retention zero (delete after analysis). No public URLs, ever.

## Trust boundaries

1. Browser/mobile capture client → platform: signed one-use capture session, nonce-bound, direct short-lived upload endpoint; client input is untrusted, including any client-computed quality/liveness.
2. Platform → verify-core: mTLS, service identity, tenant context asserted server-side.
3. verify-core → sidecar: mTLS, private network, model-hash verification of every response against the approved registry (already implemented in `providers/seetaface.py`).
4. Platform → customer: webhooks signed with tenant-specific secrets, replay-safe.

## Environments

sandbox and production are separate environments per project with separate API keys, policies and webhook secrets. Development/test/staging/production configs validated at startup; production refuses weak or missing master-key configuration and refuses non-mTLS sidecar endpoints.

## Naming alignment

Public brand architecture (BioCheck Identity Cloud → BioVerify Engine → industry solutions) maps onto this as: BioVerify Engine = verify-core + sidecar; BioCheck Identity Cloud = the platform plane; BioAPI = the /v1 developer surface. Marketing claims remain governed by the claims rules — nothing here licenses a production-readiness claim.
