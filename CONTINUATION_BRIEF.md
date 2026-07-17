# BioCheck — continuation brief (paste this as the first message in the new chat)

You are resuming the BioCheck Technologies platform build. Everything below is
current as of the handover. Do not rebuild what exists — read, then continue
from "Next actions."

## What this is
Consent-led 1:1 biometric identity-verification platform (biochecktech.com /
app.biochecktech.com). Two planes:
- `biocheck_engine/` — Python verify-core (policy, encrypted template vault,
  model registry, hash-chained audit, FastAPI facade, SeetaFace6 sidecar client,
  and fingerprint contract layer). 47/47 tests.
- `platform/` — Next.js + TypeScript + Postgres. Tenancy, RBAC, auth+MFA,
  consent, capture sessions, verification, documents, reviews, fraud,
  privacy/KMS, webhooks, console, developer portal, marketing site, fingerprint
  contract layer and demo lead capture. 139/139 tests, tsc clean, 7 migrations.

## State of the build
- All 8 build prompts (0–7) complete. Adversarial review passed (20 scenarios).
- Source is hosted at `washkap-code/biocheck-platform-verify`. CI, Docker
  Compose, ops/pilot docs and approved Concept 1 assets are present.
- NOT deployed. Production is intentionally gated by
  `docs/PRODUCTION_RELEASE_CHECKLIST.md` (pilot report, pen test, model
  attestation, named sign-offs). The code refuses to boot in production
  without a real DB, Redis, KMS and HTTPS verify-core.

## Accounts (provided by Washington)
- Vercel project: https://vercel.com/bio-check/biocheck-platform (team "bio-check")
- Supabase: https://cssduwslgcnksqjhybnk.supabase.co
- GitHub: https://github.com/washkap-code/biocheck-platform-verify

## Connected-account state
- GitHub access is connected to `washkap-code/biocheck-platform-verify`.
- Supabase schema migrations 0001–0007 are already reflected in the project.
- Confirm the Vercel connection still targets team `bio-check` before deploy.

## Fastest path to "live and selling"
Split the goal:
1. **Marketing site (biochecktech.com)** — sells the service, captures demo
   leads. Safe to go fully live now. Needs: Vercel deploy + DNS. The approved
   Concept 1 logo SVGs are in `platform/public/brand/`, and the Request-a-Demo
   form writes to `demo_requests`.
2. **Platform (app.biochecktech.com)** — the biometric console/API. Bring up in
   STAGING only until verify-core + SeetaFace6 sidecar exist and the pilot
   sign-offs are done. Verification fails closed without verify-core, so this is
   safe to demo but must not process real faces in production yet.

## Next actions (in order)
1. Publish the verify-core packaging milestone and let GitHub CI pass.
2. Confirm the Vercel connector targets the `bio-check` team.
3. Deploy `platform/` to Vercel with env vars: DATABASE_URL,
   REDIS_URL, IP_HASH_SALT, and — for staging — VERIFY_CORE_URL/API_KEY once the
   sidecar exists. Keep APP_ENV out of "production" until the gates pass.
4. Point biochecktech.com DNS at the deployment; add app. as a second project or
   subdomain route.
5. Build and deploy the existing verify-core FastAPI facade with
   `Dockerfile.verify-core` and `docs/VERIFY_CORE_DEPLOYMENT.md`.
6. Build the SeetaFace6 sidecar on an isolated Linux host per
   `docs/SEETAFACE6_BUILD_STATUS.md`; register model hashes; run the pilot.

## Key files to read first in the new chat
`PROJECT_STATUS.md`, `docs/BUILD_HANDOVER.md`, `PUSH_AND_DEPLOY.md`,
`docs/PRODUCTION_RELEASE_CHECKLIST.md`, `docs/KNOWN_LIMITATIONS.md`.

Clone `https://github.com/washkap-code/biocheck-platform-verify` to resume.
