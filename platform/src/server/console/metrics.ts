/**
 * Organisation dashboard metrics — privacy-preserving aggregates only.
 * Real queries over operational tables; no static numbers masquerading as
 * live data, no biometric content, no per-person drill-down here.
 */
import type { Db } from "../db/client";
import { authorize, type AuthContext } from "../authz/policy";

export interface OrgDashboard {
  totals: { attempts: number; approved: number; review: number; rejected: number };
  rates: { approvalPct: number | null; reviewPct: number | null; rejectPct: number | null };
  dailyVolumes: { day: string; count: number }[];
  captureQualityIssues: { reasonCode: string; count: number }[];
  webhookHealth: { status: string; count: number }[];
  activePolicies: { name: string; version: number; environmentKind: string; projectName: string }[];
  activeModels: { modelId: string; purpose: string; status: string; expiresOn: string }[];
  pendingReviews: { total: number; high: number; overdue: number };
  slaMinutes: number;
}

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

export async function getOrgDashboard(db: Db, ctx: AuthContext, organisationId: string, days = 14): Promise<OrgDashboard> {
  await authorize(db, ctx, organisationId, "org:read");
  const window = `${Math.min(days, 90)} days`;

  const totals = await db.query<{ decision: string; count: string }>(
    `SELECT decision, COUNT(*)::text AS count FROM verification_attempts
     WHERE organisation_id = $1 AND created_at > now() - $2::interval GROUP BY decision`,
    [organisationId, window],
  );
  const byDecision = Object.fromEntries(totals.rows.map((r) => [r.decision, Number(r.count)]));
  const attempts = (byDecision.approved ?? 0) + (byDecision.review ?? 0) + (byDecision.rejected ?? 0);

  const daily = await db.query<{ day: string; count: string }>(
    `SELECT date_trunc('day', created_at)::date::text AS day, COUNT(*)::text AS count
     FROM verification_attempts
     WHERE organisation_id = $1 AND created_at > now() - $2::interval
     GROUP BY 1 ORDER BY 1`,
    [organisationId, window],
  );

  const quality = await db.query<{ reason_code: string; count: string }>(
    `SELECT reason_code, COUNT(*)::text AS count FROM verification_attempts
     WHERE organisation_id = $1 AND created_at > now() - $2::interval
       AND reason_code IN ('CAPTURE_QUALITY_INSUFFICIENT','FACE_NOT_DETECTED')
     GROUP BY reason_code`,
    [organisationId, window],
  );

  const webhooks = await db.query<{ status: string; count: string }>(
    `SELECT d.status, COUNT(*)::text AS count FROM webhook_deliveries d
     JOIN webhook_endpoints e ON e.id = d.endpoint_id
     WHERE e.organisation_id = $1 GROUP BY d.status`,
    [organisationId],
  );

  const policies = await db.query<{ name: string; version: number; kind: string; project_name: string }>(
    `SELECT p.name, p.version, e.kind, pr.name AS project_name
     FROM environments e
     JOIN projects pr ON pr.id = e.project_id
     JOIN verification_policies p ON p.id = COALESCE(e.active_policy_id,
       (SELECT id FROM verification_policies WHERE organisation_id IS NULL ORDER BY version DESC LIMIT 1))
     WHERE pr.organisation_id = $1
     ORDER BY pr.name, e.kind`,
    [organisationId],
  );

  const models = await db.query<{ model_id: string; purpose: string; status: string; expires_on: string }>(
    `SELECT model_id, purpose, status, expires_on FROM model_registry ORDER BY purpose, model_id`,
  );

  const reviews = await db.query<{ total: string; high: string; overdue: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE risk_level = 'high')::text AS high,
            COUNT(*) FILTER (WHERE sla_due_at IS NOT NULL AND sla_due_at < now())::text AS overdue
     FROM review_cases WHERE organisation_id = $1 AND status = 'open'`,
    [organisationId],
  );

  const settings = await db.query<{ review_sla_minutes: number }>(
    `SELECT review_sla_minutes FROM org_settings WHERE organisation_id = $1`, [organisationId],
  );

  return {
    totals: {
      attempts,
      approved: byDecision.approved ?? 0,
      review: byDecision.review ?? 0,
      rejected: byDecision.rejected ?? 0,
    },
    rates: {
      approvalPct: pct(byDecision.approved ?? 0, attempts),
      reviewPct: pct(byDecision.review ?? 0, attempts),
      rejectPct: pct(byDecision.rejected ?? 0, attempts),
    },
    dailyVolumes: daily.rows.map((r) => ({ day: r.day, count: Number(r.count) })),
    captureQualityIssues: quality.rows.map((r) => ({ reasonCode: r.reason_code, count: Number(r.count) })),
    webhookHealth: webhooks.rows.map((r) => ({ status: r.status, count: Number(r.count) })),
    activePolicies: policies.rows.map((r) => ({
      name: r.name, version: r.version, environmentKind: r.kind, projectName: r.project_name,
    })),
    activeModels: models.rows.map((r) => ({
      modelId: r.model_id, purpose: r.purpose, status: r.status, expiresOn: r.expires_on,
    })),
    pendingReviews: {
      total: Number(reviews.rows[0]?.total ?? 0),
      high: Number(reviews.rows[0]?.high ?? 0),
      overdue: Number(reviews.rows[0]?.overdue ?? 0),
    },
    slaMinutes: settings.rows[0]?.review_sla_minutes ?? 240,
  };
}
