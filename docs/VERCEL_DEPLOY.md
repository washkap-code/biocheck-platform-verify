# Vercel deployment runbook — biochecktech.com

**Prepared 2026-07-15.** Everything below is ready; the only prerequisites are
(a) the Vercel connector/account reaching team **bio-check**, and (b) the
Supabase database password for `biocheck-platform-verify`.

## Phased posture (why APP_ENV=development first)

`validateConfig()` makes staging/production refuse to boot without
REDIS_URL + HTTPS VERIFY_CORE_URL + VERIFY_CORE_API_KEY. Neither Redis nor a
hosted verify-core exists yet, so the first public deploy runs with
`APP_ENV=development` (+ `NODE_ENV=production` builds). Consequences — all
honest and fail-closed:

- Marketing site, request-demo lead capture, auth and console: **work**.
- `/v1` biometric API: **unavailable** (`getProvider()` refuses — there is no
  fake fallback outside PGlite dev). Nothing pretends to verify anyone.
- Background jobs (webhook delivery, retention sweeps): **not running** —
  Vercel has no worker process. Not needed for Phase A (lead capture does not
  use webhooks). Phase B+ runs the worker container elsewhere (see
  DEPLOYMENT.md production topology).

| Phase | Trigger | Change |
|---|---|---|
| A — marketing live | now | Env vars from `platform/.env.vercel`; deployment protection ON until content check; then point biochecktech.com |
| B — staging platform | Redis (e.g. Upstash) + verify-core facade hosted behind HTTPS | Set REDIS_URL, VERIFY_CORE_URL, VERIFY_CORE_API_KEY, flip APP_ENV=staging; run worker somewhere persistent |
| C — production | PRODUCTION_RELEASE_CHECKLIST.md signed | KMS adapter, mTLS, APP_ENV=production |

## One-click steps (Phase A)

1. **Vercel project** in team `bio-check` (existing project `biocheck-platform`
   can be reused): **Root Directory = `platform`**, Framework = Next.js,
   build command default (`next build`), Node 22.
2. **Env vars**: copy from `platform/.env.vercel` (gitignored). Fill
   `[YOUR-DB-PASSWORD]` in DATABASE_URL — use the **transaction pooler** string
   (port 6543), never the direct connection, on serverless.
3. **Deploy** from `main` (push the repo to
   github.com/washkap-code/biocheck-platform and connect it, or `vercel deploy`
   from `biocheck-verify/` with the CLI).
4. **Smoke check** (protection can stay on; use a bypass token):
   - `/` renders with the approved Concept 1 logo (now in `public/brand/`);
   - `/request-demo` → submit the form → row appears in Supabase
     `demo_requests` (status `new`);
   - `/api/health` returns ok; `/api/v1/openapi.json` serves.
5. **Domain**: add `biochecktech.com` + `www` to the project; set the
   registrar's DNS records exactly as the Vercel dashboard shows when you add
   the domain (it displays the current A/CNAME targets).
   `app.biochecktech.com` stays unconfigured until Phase B.
6. Disable deployment protection for the production domain when content is
   approved.

## Secrets ledger

- `IP_HASH_SALT` — generated 2026-07-15, lives in `platform/.env.vercel`
  (untracked) and Vercel env; not in git.
- `VERIFY_CORE_API_KEY` — pre-generated for Phase B in the same file; set the
  identical value on the verify-core host when it exists.
- Database password — known only to Washington; never write it into the repo.

## Explicitly out of scope for Phase A

Real biometric verification of any kind (face sidecar unbuilt, fingerprint
sidecar unbuilt — `docs/FINGERPRINT_BUILD_STATUS.md`), webhooks, evidence
storage, KMS. The public site must keep labelling these accurately per
CLAIMS_REGISTER.md / PRODUCT_REALITY_MATRIX.md.
