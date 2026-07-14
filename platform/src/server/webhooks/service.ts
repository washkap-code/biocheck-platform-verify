/**
 * Signed, replay-safe webhook delivery with retry state.
 * Signature: HMAC-SHA256(secret, "<timestamp>.<body>") in X-BioCheck-Signature.
 * Consumers dedupe on X-BioCheck-Event-Id and reject stale timestamps —
 * documented in the developer portal. Delivery is at-least-once with backoff;
 * a delivery dies after MAX_ATTEMPTS and surfaces on the dashboard.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { authorize, assertProjectInOrg, type AuthContext } from "../authz/policy";
import { appendAudit } from "../audit/service";
import { hmacSha256Hex, randomToken } from "../security/crypto";
import { encryptSecret, decryptSecret } from "../security/secrets";

export const WEBHOOK_EVENTS = [
  "verification.completed",
  "verification.review_required",
  "consent.withdrawn",
  "model.status_changed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const MAX_ATTEMPTS = 6;
const BACKOFF_MINUTES = [1, 5, 15, 60, 240, 720];

export async function createWebhookEndpoint(
  db: Db, ctx: AuthContext, organisationId: string, projectId: string, environmentId: string,
  url: string, events: WebhookEvent[],
): Promise<{ endpointId: string; /** shown once */ signingSecret: string }> {
  await authorize(db, ctx, organisationId, "org:manage");
  await assertProjectInOrg(db, projectId, organisationId);
  if (!/^https:\/\//.test(url)) throw new Error("Webhook URLs must be HTTPS.");
  if (events.length === 0 || events.some((e) => !WEBHOOK_EVENTS.includes(e))) {
    throw new Error("At least one valid event type is required.");
  }
  const id = randomUUID();
  const secret = `whsec_${randomToken(24)}`;
  const secretEnc = await encryptSecret(db, organisationId, `webhook:${id}`, secret);
  await db.query(
    `INSERT INTO webhook_endpoints (id, organisation_id, project_id, environment_id, url, secret_enc, events)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, organisationId, projectId, environmentId, url, secretEnc, events],
  );
  await appendAudit(db, {
    organisationId, actorType: "user", actorId: ctx.userId, action: "webhook.endpoint_created",
    resourceType: "webhook_endpoint", resourceId: id, outcome: "success", details: { events, url },
  });
  return { endpointId: id, signingSecret: secret };
}

/** Fan out an event to every matching active endpoint in the environment. */
export async function enqueueWebhook(
  db: Db, organisationId: string, environmentId: string, eventType: WebhookEvent, payload: Record<string, unknown>,
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM webhook_endpoints
     WHERE organisation_id = $1 AND environment_id = $2 AND status = 'active' AND $3 = ANY(events)`,
    [organisationId, environmentId, eventType],
  );
  const eventId = randomUUID();
  for (const endpoint of rows) {
    await db.query(
      `INSERT INTO webhook_deliveries (id, endpoint_id, event_id, event_type, payload)
       VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), endpoint.id, eventId, eventType, JSON.stringify({ id: eventId, type: eventType, data: payload })],
    );
  }
  return rows.length;
}

export type WebhookTransport = (url: string, headers: Record<string, string>, body: string) => Promise<number>;

const defaultTransport: WebhookTransport = async (url, headers, body) => {
  const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
  return res.status;
};

/** Processes due deliveries. Invoked by the worker loop (Prompt 6 job framework). */
export async function deliverDueWebhooks(db: Db, transport: WebhookTransport = defaultTransport): Promise<{ delivered: number; failed: number }> {
  const { rows } = await db.query<{
    id: string; endpoint_id: string; event_id: string; event_type: string; payload: unknown;
    attempts: number; url: string; secret_enc: string; organisation_id: string;
  }>(
    `SELECT d.id, d.endpoint_id, d.event_id, d.event_type, d.payload, d.attempts, e.url, e.secret_enc, e.organisation_id
     FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.status IN ('pending','failed') AND d.next_attempt_at <= now() AND e.status = 'active'
     ORDER BY d.next_attempt_at ASC LIMIT 50`,
  );
  let delivered = 0, failed = 0;
  for (const row of rows) {
    const body = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const secret = await decryptSecret(db, row.organisation_id, `webhook:${row.endpoint_id}`, row.secret_enc);
    const signature = hmacSha256Hex(secret, `${timestamp}.${body}`);
    let ok = false;
    try {
      const status = await transport(row.url, {
        "Content-Type": "application/json",
        "X-BioCheck-Event-Id": row.event_id,
        "X-BioCheck-Event-Type": row.event_type,
        "X-BioCheck-Timestamp": timestamp,
        "X-BioCheck-Signature": `v1=${signature}`,
      }, body);
      ok = status >= 200 && status < 300;
    } catch {
      ok = false; // network errors are retried; response bodies are never logged
    }
    const attempts = row.attempts + 1;
    if (ok) {
      delivered++;
      await db.query(
        `UPDATE webhook_deliveries SET status = 'delivered', attempts = $2, delivered_at = now() WHERE id = $1`,
        [row.id, attempts],
      );
    } else {
      failed++;
      const dead = attempts >= MAX_ATTEMPTS;
      const backoff = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
      await db.query(
        `UPDATE webhook_deliveries SET status = $2, attempts = $3,
           next_attempt_at = now() + ($4 || ' minutes')::interval WHERE id = $1`,
        [row.id, dead ? "dead" : "failed", attempts, String(backoff)],
      );
    }
  }
  return { delivered, failed };
}

/** Verification helper published in the developer docs (and used in tests). */
export function verifyWebhookSignature(secret: string, timestamp: string, body: string, signatureHeader: string, toleranceSeconds = 300): boolean {
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;
  return signatureHeader === `v1=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}
