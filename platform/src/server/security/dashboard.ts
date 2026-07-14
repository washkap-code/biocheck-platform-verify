/**
 * Security/admin dashboard aggregates. Privacy-preserving by construction:
 * counts, dates and statuses only — no raw biometric content, no secrets.
 */
import type { Db } from "../db/client";
import { authorize, type AuthContext } from "../authz/policy";

export interface SecurityDashboard {
  keyRotation: { organisationScope: string; keyVersion: number; rotateDueAt: string; overdue: boolean }[];
  activePolicies: { name: string; version: number; scope: string }[];
  modelApprovals: { modelId: string; purpose: string; expiresOn: string; status: string; expiringSoon: boolean }[];
  webhookHealth: { status: string; count: number }[];
  highRiskAuditEvents: { action: string; outcome: string; count: number }[];
  pendingReviewCases: number;
  blockedDeletionRequests: number;
}

export async function getSecurityDashboard(db: Db, ctx: AuthContext, organisationId: string): Promise<SecurityDashboard> {
  await authorize(db, ctx, organisationId, "audit:read");

  const keys = await db.query<{ organisation_id: string | null; key_version: number; rotate_due_at: string }>(
    `SELECT organisation_id, key_version, rotate_due_at FROM tenant_keys
     WHERE status = 'active' AND (organisation_id = $1 OR organisation_id IS NULL)`,
    [organisationId],
  );
  const policies = await db.query<{ name: string; version: number; organisation_id: string | null }>(
    `SELECT DISTINCT p.name, p.version, p.organisation_id
     FROM verification_policies p
     LEFT JOIN environments e ON e.active_policy_id = p.id
     WHERE p.organisation_id = $1 OR p.organisation_id IS NULL`,
    [organisationId],
  );
  const models = await db.query<{ model_id: string; purpose: string; expires_on: string; status: string }>(
    `SELECT model_id, purpose, expires_on, status FROM model_registry ORDER BY expires_on ASC`,
  );
  const webhooks = await db.query<{ status: string; count: string }>(
    `SELECT d.status, COUNT(*)::text AS count FROM webhook_deliveries d
     JOIN webhook_endpoints e ON e.id = d.endpoint_id
     WHERE e.organisation_id = $1 GROUP BY d.status`,
    [organisationId],
  );
  const highRisk = await db.query<{ action: string; outcome: string; count: string }>(
    `SELECT action, outcome, COUNT(*)::text AS count FROM audit_events
     WHERE organisation_id = $1 AND outcome IN ('denied','failure')
       AND occurred_at > now() - interval '7 days'
     GROUP BY action, outcome ORDER BY COUNT(*) DESC LIMIT 20`,
    [organisationId],
  );
  const reviews = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM review_cases WHERE organisation_id = $1 AND status = 'open'`,
    [organisationId],
  );
  const blockedDeletions = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM subject_requests
     WHERE organisation_id = $1 AND status = 'blocked_legal_hold'`,
    [organisationId],
  );

  const soon = Date.now() + 30 * 24 * 3600 * 1000;
  return {
    keyRotation: keys.rows.map((k) => ({
      organisationScope: k.organisation_id ? "tenant" : "platform",
      keyVersion: k.key_version,
      rotateDueAt: k.rotate_due_at,
      overdue: new Date(k.rotate_due_at).getTime() < Date.now(),
    })),
    activePolicies: policies.rows.map((p) => ({
      name: p.name, version: p.version, scope: p.organisation_id ? "tenant" : "platform-default",
    })),
    modelApprovals: models.rows.map((m) => ({
      modelId: m.model_id, purpose: m.purpose, expiresOn: m.expires_on, status: m.status,
      expiringSoon: new Date(m.expires_on).getTime() < soon,
    })),
    webhookHealth: webhooks.rows.map((w) => ({ status: w.status, count: Number(w.count) })),
    highRiskAuditEvents: highRisk.rows.map((h) => ({ action: h.action, outcome: h.outcome, count: Number(h.count) })),
    pendingReviewCases: Number(reviews.rows[0]?.count ?? 0),
    blockedDeletionRequests: Number(blockedDeletions.rows[0]?.count ?? 0),
  };
}
