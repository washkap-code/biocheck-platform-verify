# Deployment — BioCheck platform

## Environments

| | development | test | staging | production |
|---|---|---|---|---|
| Database | PGlite or compose Postgres | PGlite (in-process) | managed Postgres | managed Postgres (HA) |
| Provider | FakeProvider / fake sidecar | FakeProvider | verify-core (HTTPS) | verify-core (mTLS) |
| KMS | LocalKmsAdapter (env key) | LocalKmsAdapter | cloud KMS adapter | cloud KMS/HSM adapter |
| Config gate | relaxed | relaxed | `validateConfig` hardened | hardened + refuses env master key |

`validateConfig()` runs at startup in the app and the worker. Staging/production refuse: missing DATABASE_URL/REDIS_URL/IP_HASH_SALT, PGlite, non-HTTPS VERIFY_CORE_URL, missing VERIFY_CORE_API_KEY; production additionally refuses `BIOCHECK_MASTER_KEY_B64` (KMS only) and the dev KMS adapter (`assertProductionKeyConfig`). The fake provider and fake sidecar throw if instantiated in production.

## Local development

```bash
cp platform/.env.example .env       # fill values; never commit
docker compose up                    # app :3000, worker, postgres, redis, fake sidecar
docker compose --profile storage up  # + MinIO for evidence-store development
```

Without Docker: `cd platform && DB_DRIVER=pglite npm run dev` plus `npx tsx src/server/verification/fakeSidecarServer.ts`.

## Production topology

- Platform container (`Dockerfile` target `production`, non-root) behind a TLS-terminating load balancer. Health: `/api/health` (liveness), `/api/ready` (readiness).
- Worker container (same image, worker entrypoint), ≥1 replica; jobs are claim-atomic so replicas are safe.
- Managed Postgres with WAL archiving (see runbook), managed Redis, S3-compatible object store with no public access.
- **verify-core facade + SeetaFace6 sidecar live on a private network segment**: no public ingress, mTLS from the platform, read-only model mounts, model hashes pinned in the registry. The facade is packaged by `Dockerfile.verify-core`; deploy it using `docs/VERIFY_CORE_DEPLOYMENT.md`. The native sidecar is built on the isolated Linux builder per `docs/SEETAFACE6_BUILD_STATUS.md` — never in this compose file, never on a shared host.
- Secrets injected via the platform's secret manager; images contain none (CI secret-scan gates).

## Release flow

1. CI green on main (typecheck, 90+ tests, migration check, secret scan, dependency scan, build). Image digest recorded as an artifact.
2. Complete `docs/PRODUCTION_RELEASE_CHECKLIST.md` — named human approvals; deployment is never automatic.
3. Apply migrations (worker paused), deploy the recorded image digest (staging → soak → production), verify `/api/ready`, run the smoke journey (sandbox tenant: capture session → verification → webhook received).
4. Rollback: redeploy the previous image digest. Migrations are expand-first, so N-1 code runs against N schema; if a contract migration was applied, restore from backup per the runbook instead.
