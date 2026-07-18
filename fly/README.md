# Phase B — hosting the BioVerify engine on Fly.io (EU)

Decision 2026-07-18 (DECISIONS.md): Fly.io, region `lhr`, co-located with the
Supabase database (eu-west-1). Two apps now, a third (SeetaFace6 face sidecar)
when its native image is built.

**Honest scope:** deploying this makes the `/v1` **fingerprint** pipeline real
(against the SourceAFIS sidecar) and gives the platform its staging posture.
The **face** path stays 503 fail-closed until the SeetaFace6 sidecar image is
built per `docs/SEETAFACE6_BUILD_STATUS.md` — the engine now boots
fingerprint-only by design (tested).

## One-time setup (Washington, ~20 min)

```bash
brew install flyctl
fly auth signup            # or fly auth login; add payment method when asked

# From the biocheck-verify repo root:

# 1. Fingerprint sidecar — PRIVATE, no public ingress
fly apps create biocheck-fp-sidecar
fly secrets set --app biocheck-fp-sidecar FP_SIDECAR_API_KEY=$(openssl rand -base64 32 | tee /tmp/fpkey)
cd sidecar-fingerprint && fly deploy && cd ..

# 2. verify-core facade — public HTTPS, Bearer auth
fly apps create biocheck-verify-core
fly secrets set --app biocheck-verify-core \
  VERIFY_CORE_API_KEY=<VERIFY_CORE_API_KEY value from platform/.env.vercel> \
  VERIFY_CORE_FP_SIDECAR_URL=http://biocheck-fp-sidecar.internal:8081 \
  VERIFY_CORE_FP_SIDECAR_API_KEY=$(cat /tmp/fpkey)
fly deploy --config fly/fly.verify-core.toml --dockerfile Dockerfile.verify-core
rm /tmp/fpkey

# 3. Register the deployed matcher in the model registry
python scripts/register_fp_sidecar.py \
  --url https://biocheck-verify-core.fly.dev \
  --approved-by "Washington"           # NB: run against the SIDECAR healthz —
# if the sidecar has no public URL, run it from a fly ssh console:
#   fly ssh console --app biocheck-verify-core
# then set the output:
fly secrets set --app biocheck-verify-core VERIFY_CORE_APPROVED_MODELS_JSON='<output>'

# 4. Redis for the platform (Upstash via Fly)
fly redis create            # name: biocheck-redis, region lhr, note the rediss:// URL
```

## Wire the platform (Vercel)

In the `biocheck-platform-verify` Vercel project, set:

```
REDIS_URL=rediss://...                       # from fly redis create
VERIFY_CORE_URL=https://biocheck-verify-core.fly.dev
VERIFY_CORE_API_KEY=<same value as on the Fly app>
APP_ENV=staging                              # flips the config gate
```

Redeploy. `validateConfig()` will now accept staging; the platform's
fingerprint routes go live against the real engine, face routes keep failing
closed to human review.

## Verify

1. `curl https://biocheck-verify-core.fly.dev/health` → `adapter: null`,
   `fingerprint_adapter: "FingerprintSidecar"`.
2. From the repo: `FP_SIDECAR_URL=... FP_SIDECAR_API_KEY=... pytest
   tests/test_fp_sidecar_conformance.py -v` (completes FP-001 acceptance).
3. Console → Verify Lab with a staging API key: fingerprint enrol + verify
   via the dev image upload, end to end.

## Costs (verify at fly.io/calculator before accepting)

Two always-on shared-cpu machines (512 MB + 1 GB) + Upstash Redis: roughly
$10–20/month at current published rates; the face sidecar will add one more
machine (likely 2 GB+) when built. All figures are Fly's, not BioCheck's —
check the dashboard's projection after first deploy.

## Security posture (unchanged rules)

- Sidecars: no public ingress, reachable only via Fly private networking.
- verify-core: public HTTPS with Bearer auth (Phase B); mTLS is the Phase C
  gate per `docs/DEPLOYMENT.md` — do not skip it for production.
- No biometric images at rest anywhere in this topology; templates encrypted.
- Secrets live in Fly/Vercel secret stores only, never in these files.
