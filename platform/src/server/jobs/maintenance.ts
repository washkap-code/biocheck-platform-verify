/**
 * Maintenance job handlers: webhook delivery, retention deletion, audit WORM
 * export, key-rotation reminders and model-expiry alerts. All idempotent —
 * re-running any of them is harmless by construction.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { JobRegistry, scheduleJob } from "./framework";
import { deliverDueWebhooks, enqueueWebhook } from "../webhooks/service";
import { EvidenceService, type ObjectStorageAdapter } from "../privacy/evidence";
import { appendAudit } from "../audit/service";
import { getKms, rotateTenantDek, type KmsAdapter } from "../security/kms";

export interface MaintenanceDeps {
  storage: ObjectStorageAdapter;
  /** Defaults to getKms() (env-driven) — pass an explicit adapter in tests. */
  kms?: KmsAdapter;
}

export function buildRegistry(deps: MaintenanceDeps): JobRegistry {
  const registry = new JobRegistry();
  const kms = deps.kms ?? getKms();

  /** Deliver due webhook deliveries (retry state lives on the deliveries themselves). */
  registry.register("webhooks.deliver", async (db) => {
    await deliverDueWebhooks(db);
  });

  /** Retention sweep: purge evidence past its expiry. Idempotent — already-deleted rows are skipped. */
  registry.register("retention.purge", async (db) => {
    const evidence = new EvidenceService(db, deps.storage);
    await evidence.purgeExpired();
    // Expire overdue capture sessions so the table stays small and honest.
    await db.query(`UPDATE capture_sessions SET status = 'expired' WHERE status = 'pending' AND expires_at <= now()`);
    // Drop idempotency records older than 7 days (except one-time-secret flash rows, which burn on read).
    await db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days' AND endpoint NOT LIKE '_flash%'`);
  });

  /**
   * Audit WORM export: append-only JSONL segments to object storage, with the
   * chain head recorded so tampering after export is provable. Idempotent via
   * the audit_exports high-water mark.
   */
  registry.register("audit.export", async (db) => {
    const last = await db.query<{ to_seq: string }>(`SELECT to_seq FROM audit_exports ORDER BY to_seq DESC LIMIT 1`);
    const fromSeq = Number(last.rows[0]?.to_seq ?? 0) + 1;
    const events = await db.query<{ seq: string; event_hash: string }>(
      `SELECT seq, event_hash FROM audit_events WHERE seq >= $1 ORDER BY seq ASC LIMIT 5000`, [fromSeq],
    );
    if (events.rows.length === 0) return;
    const full = await db.query(`SELECT * FROM audit_events WHERE seq >= $1 ORDER BY seq ASC LIMIT 5000`, [fromSeq]);
    const toSeq = Number(events.rows[events.rows.length - 1].seq);
    const headHash = events.rows[events.rows.length - 1].event_hash;
    const storageRef = `audit-worm/${fromSeq}-${toSeq}.jsonl`;
    const lines = full.rows.map((r) => JSON.stringify(r)).join("\n");
    await deps.storage.put(storageRef, Buffer.from(lines, "utf8"));
    await db.query(
      `INSERT INTO audit_exports (id, from_seq, to_seq, head_hash, storage_ref) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), fromSeq, toSeq, headHash, storageRef],
    );
  });

  /** Key-rotation reminders: audit event per overdue tenant key (deduped daily by dedupe_key upstream). */
  registry.register("keys.rotation_reminder", async (db) => {
    const { rows } = await db.query<{ organisation_id: string | null; key_version: number }>(
      `SELECT organisation_id, key_version FROM tenant_keys WHERE status = 'active' AND rotate_due_at <= now()`,
    );
    for (const key of rows) {
      await appendAudit(db, {
        organisationId: key.organisation_id, actorType: "system", actorId: "rotation-job",
        action: "key.rotation_overdue", resourceType: "tenant_key",
        resourceId: `v${key.key_version}`, outcome: "denied",
        details: { keyVersion: key.key_version },
      });
    }
  });

  /**
   * Key-rotation EXECUTION: actually rotates overdue tenant DEKs (issues a
   * new key_version, wraps it under the configured KMS, retires the old
   * version for decrypt-only use). Idempotent — a tenant only reappears here
   * once its *new* key's own rotate_due_at (180 days out) is overdue, so
   * re-running this job harmlessly does nothing for already-rotated tenants.
   * Runs independently of keys.rotation_reminder (which only audits/flags);
   * both stay registered so the audit trail still shows the "overdue" signal
   * even in the same tick the rotation actually executes.
   */
  registry.register("keys.rotation_execute", async (db) => {
    const { rows } = await db.query<{ organisation_id: string | null; key_version: number }>(
      `SELECT organisation_id, key_version FROM tenant_keys WHERE status = 'active' AND rotate_due_at <= now()`,
    );
    for (const key of rows) {
      const newVersion = await rotateTenantDek(db, kms, key.organisation_id);
      await appendAudit(db, {
        organisationId: key.organisation_id, actorType: "system", actorId: "rotation-job",
        action: "key.rotation_executed", resourceType: "tenant_key",
        resourceId: `v${newVersion}`, outcome: "success",
        details: { previousVersion: key.key_version, newVersion },
      });
    }
  });

  /** Model-expiry alerts: mark expired models + notify tenants via model.status_changed. */
  registry.register("models.expiry_alert", async (db) => {
    const expired = await db.query<{ id: string; model_id: string; purpose: string }>(
      `UPDATE model_registry SET status = 'expired'
       WHERE status = 'active' AND expires_on < CURRENT_DATE
       RETURNING id, model_id, purpose`,
    );
    for (const model of expired.rows) {
      await appendAudit(db, {
        organisationId: null, actorType: "system", actorId: "model-expiry-job",
        action: "model.expired", resourceType: "model_registry", resourceId: model.model_id,
        outcome: "failure", details: { purpose: model.purpose },
      });
      // Fan out to every environment with endpoints subscribed to model.status_changed.
      const envs = await db.query<{ organisation_id: string; environment_id: string }>(
        `SELECT DISTINCT organisation_id, environment_id FROM webhook_endpoints
         WHERE status = 'active' AND 'model.status_changed' = ANY(events)`,
      );
      for (const env of envs.rows) {
        await enqueueWebhook(db, env.organisation_id, env.environment_id, "model.status_changed", {
          modelId: model.model_id, purpose: model.purpose, status: "expired",
        });
      }
    }
    // Expiring soon (30 days): audit note only, once per model per day via dedupe upstream.
    const soon = await db.query<{ model_id: string }>(
      `SELECT model_id FROM model_registry WHERE status = 'active' AND expires_on < CURRENT_DATE + 30`,
    );
    for (const model of soon.rows) {
      await appendAudit(db, {
        organisationId: null, actorType: "system", actorId: "model-expiry-job",
        action: "model.expiring_soon", resourceType: "model_registry", resourceId: model.model_id, outcome: "denied",
      });
    }
  });

  return registry;
}

const RECURRING: { kind: string; everyMinutes: number }[] = [
  { kind: "webhooks.deliver", everyMinutes: 1 },
  { kind: "retention.purge", everyMinutes: 15 },
  { kind: "audit.export", everyMinutes: 60 },
  { kind: "keys.rotation_reminder", everyMinutes: 24 * 60 },
  { kind: "keys.rotation_execute", everyMinutes: 24 * 60 },
  { kind: "models.expiry_alert", everyMinutes: 24 * 60 },
];

/** Idempotently (re)schedules the recurring maintenance jobs. Called by the worker each tick. */
export async function ensureRecurringJobs(db: Db): Promise<void> {
  for (const { kind, everyMinutes } of RECURRING) {
    const slot = Math.floor(Date.now() / (everyMinutes * 60_000));
    await scheduleJob(db, kind, {}, { dedupeKey: `${kind}:${slot}` });
  }
}
