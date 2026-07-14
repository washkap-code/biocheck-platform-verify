/**
 * Idempotency for all /v1 create operations. A repeated Idempotency-Key with
 * the same request hash replays the stored response; the same key with a
 * DIFFERENT body is a client error (prevents accidental double-charging
 * semantics and replay confusion).
 */
import { randomUUID } from "node:crypto";
import type { Db } from "./db/client";
import { sha256Hex } from "./security/crypto";

export class IdempotencyConflictError extends Error {
  readonly status = 422;
}

export async function withIdempotency<T extends { status: number; body: Record<string, unknown> }>(
  db: Db, apiKeyId: string, endpoint: string, idemKey: string | null, requestBody: unknown,
  handler: () => Promise<T>,
): Promise<T & { replayed?: boolean }> {
  if (!idemKey) return handler(); // header optional but strongly recommended in docs
  if (idemKey.length > 128) throw new IdempotencyConflictError("Idempotency-Key too long.");
  const requestHash = sha256Hex(JSON.stringify(requestBody ?? {}));
  const existing = await db.query<{ request_hash: string; response_status: number; response_body: unknown }>(
    `SELECT request_hash, response_status, response_body FROM idempotency_keys
     WHERE api_key_id = $1 AND endpoint = $2 AND idem_key = $3`,
    [apiKeyId, endpoint, idemKey],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.request_hash !== requestHash) {
      throw new IdempotencyConflictError("Idempotency-Key was already used with a different request body.");
    }
    const body = (typeof row.response_body === "string" ? JSON.parse(row.response_body) : row.response_body) as T["body"];
    return { status: row.response_status, body, replayed: true } as T & { replayed: boolean };
  }
  const result = await handler();
  await db.query(
    `INSERT INTO idempotency_keys (id, api_key_id, endpoint, idem_key, request_hash, response_status, response_body)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [randomUUID(), apiKeyId, endpoint, idemKey, requestHash, result.status, JSON.stringify(result.body)],
  );
  return result;
}
