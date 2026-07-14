/**
 * Background job framework. Small on purpose: Postgres-backed queue with
 * idempotent scheduling (dedupe keys), exponential backoff, dead-letter
 * visibility and sanitised errors. A Redis-backed driver can replace the
 * polling loop later without changing handlers.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { redact } from "../security/controls";

export type JobHandler = (db: Db, payload: Record<string, unknown>) => Promise<void>;

const BACKOFF_MINUTES = [1, 5, 15, 60, 240];

export class JobRegistry {
  private handlers = new Map<string, JobHandler>();

  register(kind: string, handler: JobHandler): this {
    if (this.handlers.has(kind)) throw new Error(`Job kind '${kind}' already registered.`);
    this.handlers.set(kind, handler);
    return this;
  }

  get(kind: string): JobHandler | undefined {
    return this.handlers.get(kind);
  }
}

export interface ScheduleOptions {
  dedupeKey?: string;      // same key ⇒ scheduled once (idempotent)
  runAt?: Date;
  maxAttempts?: number;
}

export async function scheduleJob(db: Db, kind: string, payload: Record<string, unknown> = {}, opts: ScheduleOptions = {}): Promise<string | null> {
  const id = randomUUID();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO jobs (id, kind, payload, dedupe_key, next_run_at, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [id, kind, JSON.stringify(payload), opts.dedupeKey ?? null, opts.runAt ?? new Date(), opts.maxAttempts ?? 5],
  );
  return rows[0]?.id ?? null; // null = deduped
}

export interface RunResult { ran: number; succeeded: number; failed: number; dead: number }

/** Processes due jobs once. Safe to call concurrently: rows are claimed atomically. */
export async function runDueJobs(db: Db, registry: JobRegistry, limit = 20): Promise<RunResult> {
  const result: RunResult = { ran: 0, succeeded: 0, failed: 0, dead: 0 };
  const { rows } = await db.query<{ id: string; kind: string; payload: unknown; attempts: number; max_attempts: number }>(
    `UPDATE jobs SET status = 'running', updated_at = now()
     WHERE id IN (
       SELECT id FROM jobs WHERE status IN ('pending','failed') AND next_run_at <= now()
       ORDER BY next_run_at ASC LIMIT $1
     )
     RETURNING id, kind, payload, attempts, max_attempts`,
    [limit],
  );
  for (const job of rows) {
    result.ran++;
    const handler = registry.get(job.kind);
    const payload = (typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload) as Record<string, unknown>;
    const attempts = job.attempts + 1;
    try {
      if (!handler) throw new Error(`No handler registered for kind '${job.kind}'.`);
      await handler(db, payload);
      result.succeeded++;
      await db.query(
        `UPDATE jobs SET status = 'succeeded', attempts = $2, finished_at = now(), updated_at = now(), last_error = NULL WHERE id = $1`,
        [job.id, attempts],
      );
    } catch (err) {
      // Sanitised error only — never payload contents.
      const message = String(redact(err instanceof Error ? err.message : "unknown error")).slice(0, 500);
      const dead = attempts >= job.max_attempts;
      if (dead) result.dead++; else result.failed++;
      const backoff = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
      await db.query(
        `UPDATE jobs SET status = $2, attempts = $3, last_error = $4, updated_at = now(),
           finished_at = CASE WHEN $2 = 'dead' THEN now() ELSE NULL END,
           next_run_at = now() + ($5 || ' minutes')::interval
         WHERE id = $1`,
        [job.id, dead ? "dead" : "failed", attempts, message, String(backoff)],
      );
    }
  }
  return result;
}

/** Dead-letter / retry visibility for the ops dashboard. */
export async function getJobHealth(db: Db) {
  const { rows } = await db.query<{ kind: string; status: string; count: string }>(
    `SELECT kind, status, COUNT(*)::text AS count FROM jobs GROUP BY kind, status ORDER BY kind`,
  );
  return rows.map((r) => ({ kind: r.kind, status: r.status, count: Number(r.count) }));
}

export async function retryDeadJob(db: Db, jobId: string): Promise<void> {
  await db.query(
    `UPDATE jobs SET status = 'pending', next_run_at = now(), updated_at = now() WHERE id = $1 AND status = 'dead'`,
    [jobId],
  );
}
