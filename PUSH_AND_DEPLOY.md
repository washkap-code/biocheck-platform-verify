# Push & deploy — exact steps (run on your accounts)

The repo is committed and packaged. These are the commands that must run against **your** GitHub / hosting / cloud — I can't run them from the build session because it has no access to your accounts. Copy-paste in order.

> Reality check before you start: this is a full-stack app with a database, a
> private Python verify-core service and a native C++ sidecar. Steps 1–2 get the
> **code pushed**. Steps 3–6 stand up the **staging** deployment. A real
> production launch is still gated by `docs/PRODUCTION_RELEASE_CHECKLIST.md`
> (pilot report, pen test, model attestation, named sign-offs). Do not skip it.

---

## 1. Push to GitHub

```bash
# unzip biocheck-verify.zip, then from its root:
cd biocheck-verify
git init                      # (skip if the .git folder came through)
git add -A
git commit -m "BioCheck platform — Prompts 0-7"

# create the repo on github.com (private!), then:
git remote add origin git@github.com:<you>/biocheck-verify.git
git branch -M main
git push -u origin main
```

CI (`.github/workflows/ci.yml`) runs automatically on push: typecheck, 114 platform + 8 engine tests, migration check, secret scan, dependency scan, build. Confirm it's green before deploying.

## 2. Provision the backing services (staging first)

The app **refuses to boot** without these — that's intentional.

- **Postgres** — Neon, Supabase, RDS, or managed Postgres 16. Copy the connection string → `DATABASE_URL`.
- **Redis** — Upstash or managed Redis 7 → `REDIS_URL`.
- **Object store** — S3-compatible bucket, no public access → `OBJECT_STORE_URL`.
- **KMS** — AWS KMS / GCP KMS / on-prem HSM. Implement the `KmsAdapter` interface (`platform/src/server/security/kms.ts`) for your provider and wire it via `setKms()`. Production refuses the dev key adapter.

## 3. Run migrations

```bash
cd platform
DATABASE_URL=postgres://…  npm run migrate    # applies 0001–0005
```

## 4. Deploy the app

**Vercel (marketing + console + API):**
```bash
npm i -g vercel
cd platform
vercel link
# set env vars in the Vercel dashboard (Project → Settings → Environment Variables):
#   APP_ENV=staging  DATABASE_URL  REDIS_URL  IP_HASH_SALT
#   VERIFY_CORE_URL (https)  VERIFY_CORE_API_KEY  OBJECT_STORE_URL
vercel --prod        # 'prod' here = your staging project
```
Point DNS for `biochecktech.com` (and `app.`, `developers.`, `trust.`, `status.` when ready) at the deployment.

**Or Docker (app + worker together):**
```bash
docker build -t biocheck-platform --target production platform/
# run app and worker from the same image with the env vars above;
# worker command: node — src/server/jobs/worker.ts (see docker-compose.yml)
```

## 5. Stand up verify-core + the SeetaFace6 sidecar (separate, private)

This never goes on Vercel. On an isolated Linux host:

1. Build the sidecar per `docs/SEETAFACE6_BUILD_STATUS.md` (clone pinned commits, apply `native-patches/0001-tennis-gcc13-cstdlib.patch`, build the 8 units). Record binary hashes + compiler + OS digest.
2. Implement the verify-core FastAPI facade (`/v1/analyse`, `/v1/templates`, `/v1/compare`) — the platform client and wire contract are already defined in `platform/src/server/verification/providers.ts`.
3. Put an mTLS gateway in front; expose it privately as `VERIFY_CORE_URL`.
4. Register the exact model SHA-256s (`scripts/verify_model_manifest.py`) in the model registry via `/admin/platform`.

## 6. Drop in the approved brand assets

Copy the three Concept 1 SVGs from the brand kit into `platform/public/brand/`:
`biocheck-primary-dark.svg`, `biocheck-primary-light.svg`, `biocheck-icon.svg` (names referenced by `components/brand/Logo.tsx`).

## 7. Verify staging

`GET /api/ready` returns `ready`; run the smoke journey (sandbox tenant → capture session → verification → webhook received). Then, and only then, work `docs/PRODUCTION_RELEASE_CHECKLIST.md` for production.

---

### What I can do from here to help further
- If you connect a GitHub or Vercel connector in your claude.ai settings, I can drive steps 1 and 4 directly next session.
- I can build the verify-core FastAPI facade now (step 5.2) — it's self-contained and doesn't need your infra.
- I can write the concrete AWS/GCP `KmsAdapter` implementation for whichever KMS you pick.
