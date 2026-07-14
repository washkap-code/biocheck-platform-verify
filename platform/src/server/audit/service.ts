/**
 * Append-only, tamper-evident audit system.
 * Same hash-chain construction as biocheck_engine (sha256(previous + canonical JSON)).
 * The redaction guard makes it structurally impossible to write biometric or
 * secret material into an audit event.
 */
import { chainDigest } from "../security/crypto";
import type { Db } from "../db/client";
import { authorize, type AuthContext } from "../authz/policy";

const FORBIDDEN_KEY_PATTERN =
  /(embedding|image|selfie|biometric|template|password|secret|token|api_key|apikey|authorization|id_number|national_id|passport)/i;
/** Long base64/hex blobs are treated as potential media/keys and refused. */
const SUSPICIOUS_VALUE = /^(?:[A-Za-z0-9+/_-]{256,}|(?:[0-9a-fA-F]{2}){128,})={0,2}$/;

export class AuditRedactionError extends Error {}

export function assertSafeDetails(details: Record<string, unknown>, path = ""): void {
  for (const [key, value] of Object.entries(details)) {
    const where = path ? `${path}.${key}` : key;
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      throw new AuditRedactionError(`Audit details may not contain '${where}'.`);
    }
    if (typeof value === "string" && SUSPICIOUS_VALUE.test(value)) {
      throw new AuditRedactionError(`Audit details value at '${where}' looks like raw media or key material.`);
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      assertSafeDetails(value as Record<string, unknown>, where);
    }
  }
}

export interface AuditEventInput {
  organisationId: string | null;
  actorType: "user" | "api_key" | "system";
  actorId: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  requestId?: string | null;
  ipMinimised?: string | null;
  outcome: "success" | "denied" | "failure";
  details?: Record<string, unknown>;
}

/**
 * Fixed advisory-lock key for the audit chain. The chain is a single global
 * sequence across every organisation (queries below have no WHERE org_id —
 * `seq`/`previous_hash` form one total order), so serialisation must be
 * global too: a per-org lock would still let two different orgs' events race
 * for the same head and fork the chain.
 */
const AUDIT_CHAIN_LOCK_KEY = 7735100191;

export async function appendAudit(db: Db, input: AuditEventInput): Promise<string> {
  const details = input.details ?? {};
  assertSafeDetails(details);
  // Hold a transaction-scoped advisory lock for the read-head + insert pair.
  // Without this, two concurrent callers can both read the same previous
  // head, compute different event_hash values from it (so the UNIQUE
  // constraint on event_hash never trips), and insert two events that both
  // claim the same parent — a forked chain that verifyAuditChain will then
  // report as tampered even though nothing malicious happened. The lock is
  // acquired and released within one dedicated connection/transaction via
  // withTransaction, so it actually guards the statements that follow it.
  return db.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_CHAIN_LOCK_KEY]);
    const { rows } = await tx.query<{ event_hash: string }>(
      `SELECT event_hash FROM audit_events ORDER BY seq DESC LIMIT 1`,
    );
    const previousHash = rows[0]?.event_hash ?? "";
    const eventHash = chainDigest(
      {
        organisationId: input.organisationId,
        actorType: input.actorType,
        actorId: input.actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        requestId: input.requestId ?? null,
        outcome: input.outcome,
        details,
      },
      previousHash,
    );
    await tx.query(
      `INSERT INTO audit_events (organisation_id, actor_type, actor_id, action, resource_type,
         resource_id, request_id, ip_minimised, outcome, details, previous_hash, event_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        input.organisationId, input.actorType, input.actorId, input.action, input.resourceType,
        input.resourceId ?? null, input.requestId ?? null, input.ipMinimised ?? null,
        input.outcome, JSON.stringify(details), previousHash, eventHash,
      ],
    );
    return eventHash;
  });
}

export interface AuditRow {
  seq: number;
  occurred_at: string;
  organisation_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string | null;
  outcome: string;
  details: unknown;
  previous_hash: string;
  event_hash: string;
}

export async function verifyAuditChain(db: Db): Promise<boolean> {
  const { rows } = await db.query<AuditRow>(`SELECT * FROM audit_events ORDER BY seq ASC`);
  let previous = "";
  for (const row of rows) {
    if (row.previous_hash !== previous) return false;
    const details = typeof row.details === "string" ? JSON.parse(row.details) : row.details;
    const recomputed = chainDigest(
      {
        organisationId: row.organisation_id,
        actorType: row.actor_type,
        actorId: row.actor_id,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        requestId: row.request_id,
        outcome: row.outcome,
        details,
      },
      previous,
    );
    if (recomputed !== row.event_hash) return false;
    previous = row.event_hash;
  }
  return true;
}

export interface AuditFilter {
  action?: string;
  actorId?: string;
  outcome?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

/** Role-guarded query used by the admin audit viewer and CSV export. */
export async function queryAudit(
  db: Db,
  ctx: AuthContext,
  organisationId: string,
  filter: AuditFilter = {},
): Promise<AuditRow[]> {
  await authorize(db, ctx, organisationId, "audit:read");
  const clauses = [`organisation_id = $1`];
  const params: unknown[] = [organisationId];
  if (filter.action) { params.push(filter.action); clauses.push(`action = $${params.length}`); }
  if (filter.actorId) { params.push(filter.actorId); clauses.push(`actor_id = $${params.length}`); }
  if (filter.outcome) { params.push(filter.outcome); clauses.push(`outcome = $${params.length}`); }
  if (filter.from) { params.push(filter.from.toISOString()); clauses.push(`occurred_at >= $${params.length}`); }
  if (filter.to) { params.push(filter.to.toISOString()); clauses.push(`occurred_at <= $${params.length}`); }
  params.push(Math.min(filter.limit ?? 200, 1000));
  const { rows } = await db.query<AuditRow>(
    `SELECT * FROM audit_events WHERE ${clauses.join(" AND ")} ORDER BY seq DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function exportAuditCsv(
  db: Db,
  ctx: AuthContext,
  organisationId: string,
  filter: AuditFilter = {},
): Promise<string> {
  await authorize(db, ctx, organisationId, "audit:export");
  const rows = await queryAudit(db, ctx, organisationId, { ...filter, limit: 1000 });
  const header = "seq,occurred_at,actor_type,actor_id,action,resource_type,resource_id,request_id,outcome,event_hash";
  const escape = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const lines = rows.map((r) =>
    [r.seq, r.occurred_at, r.actor_type, r.actor_id, r.action, r.resource_type, r.resource_id, r.request_id, r.outcome, r.event_hash]
      .map(escape).join(","),
  );
  return [header, ...lines].join("\n");
}
