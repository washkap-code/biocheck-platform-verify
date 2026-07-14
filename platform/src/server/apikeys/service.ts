/**
 * Scoped API keys per project + environment.
 * Format: bck_<env>_<prefix>.<secret>. The secret is shown exactly once at
 * creation; only its SHA-256 is stored. Scope checks are explicit — a key can
 * never act outside its environment or its granted scopes.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { authorize, assertProjectInOrg, AuthorizationError, type AuthContext } from "../authz/policy";
import { appendAudit } from "../audit/service";
import { randomToken, sha256Hex, safeEqualHex } from "../security/crypto";

export const API_SCOPES = [
  "verification:create", "verification:read",
  "enrolment:create", "consent:manage", "webhook:manage",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface CreatedApiKey { apiKeyId: string; /** shown once */ secretKey: string; prefix: string }

export async function createApiKey(
  db: Db, ctx: AuthContext, organisationId: string, projectId: string, environmentId: string,
  name: string, scopes: ApiScope[], expiresAt?: Date,
): Promise<CreatedApiKey> {
  await authorize(db, ctx, organisationId, "apikeys:create");
  await assertProjectInOrg(db, projectId, organisationId);
  const env = await db.query<{ kind: string }>(
    `SELECT kind FROM environments WHERE id = $1 AND project_id = $2`,
    [environmentId, projectId],
  );
  if (env.rows.length === 0) throw new AuthorizationError("Environment does not belong to this project.");
  if (scopes.length === 0 || scopes.some((s) => !API_SCOPES.includes(s))) {
    throw new Error("At least one valid scope is required.");
  }
  const id = randomUUID();
  const prefix = `bck_${env.rows[0].kind}_${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)}`;
  const secret = randomToken(32);
  await db.query(
    `INSERT INTO api_keys (id, project_id, environment_id, organisation_id, name, prefix, key_hash, scopes, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, projectId, environmentId, organisationId, name, prefix, sha256Hex(secret), scopes, ctx.userId, expiresAt ?? null],
  );
  await appendAudit(db, {
    organisationId, actorType: "user", actorId: ctx.userId, action: "apikey.created",
    resourceType: "api_key", resourceId: id, outcome: "success",
    details: { scopes, environment: env.rows[0].kind, name },
  });
  return { apiKeyId: id, secretKey: `${prefix}.${secret}`, prefix };
}

export interface ApiKeyPrincipal {
  apiKeyId: string; organisationId: string; projectId: string; environmentId: string;
  environmentKind: string; scopes: ApiScope[];
}

/** Authenticates a presented key and enforces one required scope. */
export async function authenticateApiKey(db: Db, presented: string, requiredScope: ApiScope): Promise<ApiKeyPrincipal> {
  const dot = presented.lastIndexOf(".");
  if (dot === -1) throw new AuthorizationError("Malformed API key.");
  const prefix = presented.slice(0, dot);
  const secret = presented.slice(dot + 1);
  const { rows } = await db.query<{
    id: string; organisation_id: string; project_id: string; environment_id: string;
    key_hash: string; scopes: ApiScope[]; revoked_at: string | null; expires_at: string | null; kind: string;
  }>(
    `SELECT k.*, e.kind FROM api_keys k JOIN environments e ON e.id = k.environment_id WHERE k.prefix = $1`,
    [prefix],
  );
  const key = rows[0];
  // Constant-time: a plain !== leaks timing information about how many
  // leading bytes of the stored hash match the presented secret's hash.
  if (!key || !safeEqualHex(key.key_hash, sha256Hex(secret))) throw new AuthorizationError("Invalid API key.");
  if (key.revoked_at) throw new AuthorizationError("API key has been revoked.");
  if (key.expires_at && new Date(key.expires_at) < new Date()) throw new AuthorizationError("API key has expired.");
  const scopes = Array.isArray(key.scopes) ? key.scopes : JSON.parse(String(key.scopes));
  if (!scopes.includes(requiredScope)) {
    await appendAudit(db, {
      organisationId: key.organisation_id, actorType: "api_key", actorId: key.id,
      action: "apikey.scope_denied", resourceType: "api_key", resourceId: key.id,
      outcome: "denied", details: { requiredScope },
    });
    throw new AuthorizationError(`API key lacks the '${requiredScope}' scope.`);
  }
  await db.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [key.id]);
  return {
    apiKeyId: key.id, organisationId: key.organisation_id, projectId: key.project_id,
    environmentId: key.environment_id, environmentKind: key.kind, scopes,
  };
}

export async function revokeApiKey(db: Db, ctx: AuthContext, organisationId: string, apiKeyId: string) {
  await authorize(db, ctx, organisationId, "apikeys:revoke");
  const { rows } = await db.query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND organisation_id = $2 AND revoked_at IS NULL RETURNING id`,
    [apiKeyId, organisationId],
  );
  if (rows.length === 0) throw new AuthorizationError("API key not found in this organisation.");
  await appendAudit(db, {
    organisationId, actorType: "user", actorId: ctx.userId, action: "apikey.revoked",
    resourceType: "api_key", resourceId: apiKeyId, outcome: "success",
  });
}
