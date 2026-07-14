# BioCheck — continuation brief (paste this as the first message in the new chat)

You are resuming the BioCheck Technologies platform build. Everything below is
current as of the handover. Do not rebuild what exists — read, then continue
from "Next actions."

## What this is
Consent-led 1:1 biometric identity-verification platform (biochecktech.com /
app.biochecktech.com). Two planes:
- `biocheck_engine/` — Python verify-core (policy, encrypted template vault,
  model registry, hash-chained audit, SeetaFace6 sidecar client). 8/8 tests.
- `platform/` — Next.js + TypeScript + Postgres. Tenancy, RBAC, auth+MFA,
  consent, capture sessions, verification, documents, reviews, fraud,
  privacy/KMS, webhooks, console, developer portal, marketing site. 114/114
  tests, tsc clean, `next build` passing, 5 migrations.

## State of the build
- All 8 build prompts (0–7) complete. Adversarial review passed (20 scenarios).
- Repo is committed locally and packaged as `biocheck-verify.zip` (219 files,
  no secrets, no node_modules). CI, Docker Compose, ops/pilot docs all present.
- NOT deployed. Production is intentionally gated by
  `docs/PRODUCTION_RELEASE_CHECKLIST.md` (pilot report, pen test, model
  attestation, named sign-offs). The code refuses to boot in production
  without a real DB, Redis, KMS and HTTPS verify-core.

## Accounts (provided by Washington)
- Vercel project: https://vercel.com/bio-check/biocheck-platform (team "bio-check")
- Supabase: https://cssduwslgcnksqjhybnk.supabase.co
- GitHub: https://github.com/washkap-code/biocheck-platform

## Connector reality (verified in the previous session)
The claude.ai connectors that were authorized pointed at DIFFERENT accounts than
the three above:
- Vercel connector → team "Washington Kapapiro's projects" (empty), NOT "bio-check".
- Supabase connector → org holding ziproh-compliance / veza-jewelry / vaka-platform,
  NOT the `cssduwslgcnksqjhybnk` project.
- No GitHub connector at all.
**Action for the new chat:** confirm the connectors are authorized to the SAME
accounts as the three links above (reconnect in claude.ai settings if not),
OR agree to deploy into the connected personal accounts instead.

## Fastest path to "live and selling"
Split the goal:
1. **Marketing site (biochecktech.com)** — sells the service, captures demo
   leads. Safe to go fully live now. Needs: Vercel deploy + DNS + the three
   approved Concept 1 logo SVGs into `platform/public/brand/` + a destination
   for the Request-a-Demo form.
2. **Platform (app.biochecktech.com)** — the biometric console/API. Bring up in
   STAGING only until verify-core + SeetaFace6 sidecar exist and the pilot
   sign-offs are done. Verification fails closed without verify-core, so this is
   safe to demo but must not process real faces in production yet.

## Next actions (in order)
1. Confirm/authorize the correct Vercel + Supabase connectors (or GitHub).
2. Apply the 5 migrations (`platform/src/server/db/migrations/0001–0005`) to the
   Supabase Postgres (`apply_migration` or `npm run migrate` with DATABASE_URL).
3. Deploy `platform/` to Vercel (bio-check team) with env vars: DATABASE_URL,
   REDIS_URL, IP_HASH_SALT, and — for staging — VERIFY_CORE_URL/API_KEY once the
   sidecar exists. Keep APP_ENV out of "production" until the gates pass.
4. Point biochecktech.com DNS at the deployment; add app. as a second project or
   subdomain route.
5. Drop the approved logo SVGs into `platform/public/brand/`.
6. Wire the Request-a-Demo form to a real lead destination.
7. Build the verify-core FastAPI facade (`/v1/analyse`, `/v1/templates`,
   `/v1/compare`) — self-contained, unblocks the sidecar.
8. Build the SeetaFace6 sidecar on an isolated Linux host per
   `docs/SEETAFACE6_BUILD_STATUS.md`; register model hashes; run the pilot.

## Key files to read first in the new chat
`PROJECT_STATUS.md`, `docs/BUILD_HANDOVER.md`, `PUSH_AND_DEPLOY.md`,
`docs/PRODUCTION_RELEASE_CHECKLIST.md`, `docs/KNOWN_LIMITATIONS.md`.

The full source is in `biocheck-verify.zip` — unzip it into the new session's
working folder (or push it to github.com/washkap-code/biocheck-platform) so the
new chat has the code.
