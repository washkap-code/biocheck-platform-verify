# Operations runbook — BioCheck platform

Audience: on-call engineer. Everything here assumes the containerised deployment from `docs/DEPLOYMENT.md`. Logs are redacted by default; never work around that.

## Daily state of health

Check, in order: `/api/ready` (app + DB), worker log line `jobs processed`, `/admin/platform` KPIs (dead webhooks, open reviews, blocked deletions), `/admin/security` (key rotation due, model expiry). Job queue visibility: `getJobHealth` counts per kind/status; dead jobs are visible and re-runnable via `retryDeadJob` (never edit the jobs table by hand).

## Backup and restore

- **Backups:** continuous WAL archiving plus a nightly `pg_dump -Fc` of the full database, encrypted at rest, stored in a separate account/region from the primary. Retention 35 days. The object store (evidence + audit WORM segments) is versioned with delete protection.
- **Restore drill (run quarterly, timed):**
  1. Provision a fresh Postgres instance.
  2. `pg_restore -d biocheck --no-owner <dump>` (or PITR to the target timestamp via WAL).
  3. Run the app with `APP_ENV=staging` against the restored DB; `/api/ready` must pass.
  4. Verify the audit chain end-to-end (`verifyAuditChain`) and compare the head hash with the latest `audit_exports.head_hash` — a mismatch means data loss or tampering; escalate per INCIDENT_RESPONSE.md.
  5. Record time-to-restore in the drill log.
- **Objectives: RPO ≤ 15 minutes (WAL), RTO ≤ 4 hours** for full platform restore. The verification service degrades safely during DR: with the sidecar unreachable, decisions fail closed to review — no silent approvals ever.

## Migration strategy

Migrations are plain SQL, forward-only, applied by the built-in runner (`npm run migrate`) which records each file in `_migrations`. Rules: never edit an applied migration — add a new one; destructive changes (drops/renames) ship in two releases (expand, then contract); every migration must apply cleanly to an empty database (CI enforces this); back up before applying in production; apply during a maintenance window with the worker paused (SIGTERM, wait for `worker stopped`).

## Job operations

All jobs are idempotent. Backoff: 1/5/15/60/240 min, dead after max attempts (default 5) with a sanitised `last_error`. Recurring kinds and cadence: webhooks.deliver (1 min), retention.purge (15 min), audit.export (60 min), keys.rotation_reminder (daily), models.expiry_alert (daily). A stuck `running` job after a worker crash: safe to reset to `pending` — handlers tolerate re-execution.

## Common incidents

- **Dead webhook deliveries climbing:** endpoint down or secret rotated on the consumer side. Confirm with the tenant, fix the endpoint, `UPDATE webhook_deliveries SET status='failed', next_attempt_at=now() WHERE status='dead' AND endpoint_id=…` to replay.
- **Model expired (`model.expired` audit events):** verifications now route to review. Registry approval of the renewed model version (super-admin) restores normal flow; never extend `expires_on` without a fresh independent report reference.
- **verify-core unreachable:** decisions fail closed to review; review queue grows. Page whoever owns the sidecar; consider raising review SLA alerting thresholds temporarily. Do NOT switch provider config to the fake — it refuses production anyway.
- **Key rotation overdue (`key.rotation_overdue`):** run `rotateTenantDek` per flagged tenant during a quiet window; old versions remain decrypt-only.

## Vulnerability management

CI blocks on critical npm audit/OSV findings and on any gitleaks secret hit. Weekly: review non-critical findings; monthly: bump base images (node:22-alpine, postgres:16-alpine, redis:7-alpine) and rebuild.
