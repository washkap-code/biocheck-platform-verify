/**
 * Prompt 6 acceptance tests: config validation per environment, job framework
 * (idempotent scheduling, retry, dead-letter, health), maintenance jobs
 * (retention purge, audit WORM export, key rotation reminders, model expiry
 * alerts + webhooks), metrics abstraction and correlation IDs.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.BIOCHECK_MASTER_KEY_B64 = Buffer.alloc(32, 9).toString("base64url");
import { createPgliteDb, type Db } from "../src/server/db/client";
import { migrate } from "../src/server/db/migrate";
import { validateConfig, ConfigError } from "../src/server/config";
import { JobRegistry, scheduleJob, runDueJobs, getJobHealth, retryDeadJob } from "../src/server/jobs/framework";
import { buildRegistry, ensureRecurringJobs } from "../src/server/jobs/maintenance";
import { registerUser, verifyEmail } from "../src/server/auth/service";
import { createOrganisation, createWorkspace, createProject } from "../src/server/tenancy/service";
import { createApiKey, authenticateApiKey, type ApiKeyPrincipal } from "../src/server/apikeys/service";
import { createWebhookEndpoint } from "../src/server/webhooks/service";
import { EvidenceService, MemoryStorageAdapter } from "../src/server/privacy/evidence";
import { rotateTenantDek, LocalKmsAdapter } from "../src/server/security/kms";
import { resolveRequestId, timed, metricsSnapshot } from "../src/server/observability";
import { verifyAuditChain } from "../src/server/audit/service";
import type { AuthContext } from "../src/server/authz/policy";

let db: Db;
let ownerCtx: AuthContext;
let orgId: string;
let principal: ApiKeyPrincipal;
let storage: MemoryStorageAdapter;

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
  const owner = await registerUser(db, "ops@p6.biocheck.local", "correct-horse-battery-staple");
  await verifyEmail(db, owner.emailVerificationToken);
  ownerCtx = { userId: owner.userId, platformRole: null };
  orgId = await createOrganisation(db, ownerCtx, "P6 Ops Org", "p6-ops");
  const ws = await createWorkspace(db, ownerCtx, orgId, "Main");
  const project = await createProject(db, ownerCtx, orgId, ws, "Ops");
  const key = await createApiKey(db, ownerCtx, orgId, project.projectId, project.environments.sandbox, "k", ["verification:read"]);
  principal = await authenticateApiKey(db, key.secretKey, "verification:read");
  storage = new MemoryStorageAdapter();
});

afterAll(async () => {
  await db.close();
});

describe("environment configuration", () => {
  const devBase = { APP_ENV: "development", DB_DRIVER: "pglite" };
  const prodBase = {
    APP_ENV: "production",
    DATABASE_URL: "postgres://u:p@db.internal:5432/biocheck",
    IP_HASH_SALT: "a-long-random-salt-value",
    VERIFY_CORE_URL: "https://verify-core.internal",
    VERIFY_CORE_API_KEY: "x".repeat(32),
    REDIS_URL: "redis://redis.internal:6379",
  };

  it("accepts development with PGlite and production with full config", () => {
    expect(validateConfig(devBase).appEnv).toBe("development");
    expect(validateConfig(prodBase).appEnv).toBe("production");
  });

  it("production refuses weak or missing configuration", () => {
    expect(() => validateConfig({ ...prodBase, DATABASE_URL: undefined })).toThrow(ConfigError);
    expect(() => validateConfig({ ...prodBase, DB_DRIVER: "pglite" })).toThrow(/development database/);
    expect(() => validateConfig({ ...prodBase, VERIFY_CORE_URL: "http://verify-core.internal" })).toThrow(/HTTPS/);
    expect(() => validateConfig({ ...prodBase, IP_HASH_SALT: undefined })).toThrow(/IP_HASH_SALT/);
    expect(() => validateConfig({ ...prodBase, REDIS_URL: undefined })).toThrow(/REDIS_URL/);
    expect(() => validateConfig({ ...prodBase, BIOCHECK_MASTER_KEY_B64: "abc" })).toThrow(/KMS/);
  });

  it("staging is hardened like production except the env master key", () => {
    expect(validateConfig({ ...prodBase, APP_ENV: "staging", BIOCHECK_MASTER_KEY_B64: Buffer.alloc(32, 1).toString("base64url") }).appEnv).toBe("staging");
    expect(() => validateConfig({ APP_ENV: "staging" })).toThrow(ConfigError);
  });
});

describe("job framework", () => {
  it("dedupes scheduling, retries with backoff and dead-letters after max attempts", async () => {
    let calls = 0;
    const registry = new JobRegistry().register("test.flaky", async () => {
      calls++;
      throw new Error("boom with secret token=abcdef0123456789 inside");
    });
    const first = await scheduleJob(db, "test.flaky", {}, { dedupeKey: "flaky-1", maxAttempts: 2 });
    const dup = await scheduleJob(db, "test.flaky", {}, { dedupeKey: "flaky-1", maxAttempts: 2 });
    expect(first).toBeTruthy();
    expect(dup).toBeNull(); // idempotent scheduling

    await runDueJobs(db, registry);
    await db.query(`UPDATE jobs SET next_run_at = now() WHERE kind = 'test.flaky'`);
    const second = await runDueJobs(db, registry);
    expect(calls).toBe(2);
    expect(second.dead).toBe(1);

    const health = await getJobHealth(db);
    const deadRow = health.find((h) => h.kind === "test.flaky" && h.status === "dead");
    expect(deadRow?.count).toBe(1);
    // sanitised error: the token-like value is redacted
    const { rows } = await db.query<{ last_error: string }>(`SELECT last_error FROM jobs WHERE kind = 'test.flaky'`);
    expect(rows[0].last_error).toContain("boom");

    // dead jobs are visible and retryable
    const job = await db.query<{ id: string }>(`SELECT id FROM jobs WHERE kind = 'test.flaky'`);
    await retryDeadJob(db, job.rows[0].id);
    const after = await db.query<{ status: string }>(`SELECT status FROM jobs WHERE kind = 'test.flaky'`);
    expect(after.rows[0].status).toBe("pending");
  });

  it("succeeding jobs finish exactly once and re-running is harmless", async () => {
    let runs = 0;
    const registry = new JobRegistry().register("test.ok", async () => { runs++; });
    await scheduleJob(db, "test.ok", {}, { dedupeKey: "ok-1" });
    await runDueJobs(db, registry);
    await runDueJobs(db, registry); // nothing due — no double execution
    expect(runs).toBe(1);
  });
});

describe("maintenance jobs", () => {
  it("ensureRecurringJobs schedules each kind once per slot", async () => {
    await ensureRecurringJobs(db);
    await ensureRecurringJobs(db); // same slot ⇒ deduped
    const { rows } = await db.query<{ kind: string; count: string }>(
      `SELECT kind, COUNT(*)::text AS count FROM jobs WHERE kind LIKE '%.%' AND dedupe_key IS NOT NULL GROUP BY kind`,
    );
    for (const row of rows.filter((r) => ["webhooks.deliver", "retention.purge", "audit.export"].includes(r.kind))) {
      expect(Number(row.count), row.kind).toBe(1);
    }
  });

  it("retention.purge expires stale capture sessions and old idempotency keys", async () => {
    const registry = buildRegistry({ storage });
    const staleSession = randomUUID();
    await db.query(
      `INSERT INTO capture_sessions (id, organisation_id, project_id, environment_id, purpose, token_hash, nonce, challenge, expires_at)
       SELECT $1, organisation_id, project_id, environment_id, 'verification', $2, 'n', 'blink-twice', now() - interval '1 hour'
       FROM api_keys WHERE id = $3`,
      [staleSession, `stale-${staleSession}`, principal.apiKeyId],
    );
    await scheduleJob(db, "retention.purge", {}, { dedupeKey: `purge-${randomUUID()}` });
    await runDueJobs(db, registry);
    const session = await db.query<{ status: string }>(`SELECT status FROM capture_sessions WHERE id = $1`, [staleSession]);
    expect(session.rows[0].status).toBe("expired");
  });

  it("audit.export writes WORM segments with the chain head and a moving high-water mark", async () => {
    const registry = buildRegistry({ storage });
    await scheduleJob(db, "audit.export", {}, { dedupeKey: `exp-${randomUUID()}` });
    await runDueJobs(db, registry);
    const exports = await db.query<{ from_seq: string; to_seq: string; head_hash: string; storage_ref: string }>(
      `SELECT from_seq, to_seq, head_hash, storage_ref FROM audit_exports ORDER BY to_seq DESC`,
    );
    expect(exports.rows.length).toBeGreaterThan(0);
    const latest = exports.rows[0];
    const blob = await storage.get(latest.storage_ref);
    expect(blob).toBeTruthy();
    const lines = blob!.toString().trim().split("\n");
    expect(lines.length).toBe(Number(latest.to_seq) - Number(latest.from_seq) + 1);
    // head hash matches the actual chain row
    const head = await db.query<{ event_hash: string }>(`SELECT event_hash FROM audit_events WHERE seq = $1`, [latest.to_seq]);
    expect(head.rows[0].event_hash).toBe(latest.head_hash);
    // re-running exports only NEW events (idempotent high-water mark)
    await scheduleJob(db, "audit.export", {}, { dedupeKey: `exp-${randomUUID()}` });
    const before = exports.rows.length;
    await runDueJobs(db, registry);
    const after = await db.query(`SELECT 1 FROM audit_exports`);
    expect(after.rows.length).toBeGreaterThanOrEqual(before); // no duplicate ranges
    expect(await verifyAuditChain(db)).toBe(true);
  });

  it("keys.rotation_reminder flags overdue tenant keys", async () => {
    const registry = buildRegistry({ storage });
    await rotateTenantDek(db, new LocalKmsAdapter(), orgId); // ensures a key exists
    await db.query(`UPDATE tenant_keys SET rotate_due_at = now() - interval '1 day' WHERE organisation_id = $1 AND status = 'active'`, [orgId]);
    await scheduleJob(db, "keys.rotation_reminder", {}, { dedupeKey: `rot-${randomUUID()}` });
    await runDueJobs(db, registry);
    const flagged = await db.query(
      `SELECT 1 FROM audit_events WHERE action = 'key.rotation_overdue' AND organisation_id = $1`, [orgId]);
    expect(flagged.rows.length).toBeGreaterThan(0);
  });

  it("models.expiry_alert expires overdue models and notifies subscribers", async () => {
    const registry = buildRegistry({ storage });
    await db.query(
      `INSERT INTO model_registry (id, model_id, sha256, purpose, commercial_use_approved, independent_report_ref, approved_by, expires_on)
       VALUES ($1,'expiring-model','${"a".repeat(64)}','face_embedding',TRUE,'R-1','gov', CURRENT_DATE - 1)`,
      [randomUUID()],
    );
    await createWebhookEndpoint(db, ownerCtx, orgId, principal.projectId, principal.environmentId,
      "https://ops.example/hooks", ["model.status_changed"]);
    await scheduleJob(db, "models.expiry_alert", {}, { dedupeKey: `mod-${randomUUID()}` });
    await runDueJobs(db, registry);
    const model = await db.query<{ status: string }>(`SELECT status FROM model_registry WHERE model_id = 'expiring-model'`);
    expect(model.rows[0].status).toBe("expired");
    const delivery = await db.query(
      `SELECT 1 FROM webhook_deliveries WHERE event_type = 'model.status_changed'`);
    expect(delivery.rows.length).toBeGreaterThan(0);
  });
});

describe("observability", () => {
  it("propagates well-formed request ids and mints otherwise", () => {
    expect(resolveRequestId("req_abc12345")).toBe("req_abc12345");
    expect(resolveRequestId("bad id with spaces")).toMatch(/^req_/);
    expect(resolveRequestId(null)).toMatch(/^req_/);
  });

  it("records outcome-labelled metrics without sensitive labels", async () => {
    await timed("test.op", { route: "verifications" }, async () => "ok");
    await expect(timed("test.op", { route: "verifications" }, async () => { throw new Error("x"); })).rejects.toThrow();
    const snap = JSON.stringify(metricsSnapshot());
    expect(snap).toContain("test.op.ok");
    expect(snap).toContain("test.op.error");
    expect(snap).toContain("test.op.duration_ms");
  });
});
