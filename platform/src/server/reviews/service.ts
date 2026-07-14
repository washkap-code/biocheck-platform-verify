/**
 * Review operations.
 *
 * - Queue ordered/filtered by risk, SLA, reason code and age.
 * - Dual control: high-risk cases need two DIFFERENT reviewers; the first
 *   records an intent, the second (who may disagree) decides.
 * - A confirmed liveness failure is REJECTED, not reviewable. It can only be
 *   escalated into a dual-control exception case when the tenant has
 *   explicitly enabled allow_liveness_exception — and even then it always
 *   requires two named reviewers.
 * - Every reviewer action lands in the immutable audit chain and (on final
 *   decision) a webhook.
 * - Quality feedback loop: aggregated capture-failure reasons plus safe,
 *   end-user retry tips per reason code.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { authorize, type AuthContext } from "../authz/policy";
import { appendAudit } from "../audit/service";
import { enqueueWebhook } from "../webhooks/service";
import { VerificationError } from "../verification/service";

export interface ReviewQueueFilter {
  riskLevel?: "standard" | "high";
  reasonCode?: string;
  overdueOnly?: boolean;
  limit?: number;
}

export async function getReviewQueue(db: Db, ctx: AuthContext, organisationId: string, filter: ReviewQueueFilter = {}) {
  await authorize(db, ctx, organisationId, "reviews:decide");
  const clauses = [`r.organisation_id = $1`, `r.status = 'open'`];
  const params: unknown[] = [organisationId];
  if (filter.riskLevel) { params.push(filter.riskLevel); clauses.push(`r.risk_level = $${params.length}`); }
  if (filter.reasonCode) { params.push(filter.reasonCode); clauses.push(`r.reason_code_at_open = $${params.length}`); }
  if (filter.overdueOnly) clauses.push(`r.sla_due_at IS NOT NULL AND r.sla_due_at < now()`);
  params.push(Math.min(filter.limit ?? 100, 500));
  const { rows } = await db.query(
    `SELECT r.id, r.verification_attempt_id, r.reason_code_at_open, r.risk_level, r.requires_dual_control,
            r.first_approval_by, r.first_approval_outcome, r.sla_due_at, r.created_at,
            (r.sla_due_at IS NOT NULL AND r.sla_due_at < now()) AS overdue,
            EXTRACT(EPOCH FROM (now() - r.created_at))::bigint AS age_seconds,
            v.decision AS attempt_decision, s.subject_ref
     FROM review_cases r
     JOIN verification_attempts v ON v.id = r.verification_attempt_id
     JOIN subjects s ON s.id = v.subject_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY (r.risk_level = 'high') DESC, r.sla_due_at ASC NULLS LAST, r.created_at ASC
     LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/**
 * Decide a review case with dual-control support.
 * Standard cases: one reviewer + written reason (unchanged behaviour).
 * Dual-control cases: first call records intent; a DIFFERENT reviewer makes
 * the final decision. Self-confirmation is refused.
 */
export async function decideReviewCaseDual(
  db: Db, ctx: AuthContext, organisationId: string, reviewCaseId: string,
  outcome: "approved" | "rejected", reason: string,
): Promise<{ status: string; final: boolean }> {
  await authorize(db, ctx, organisationId, "reviews:decide");
  if (!reason || reason.trim().length < 5) {
    throw new VerificationError("A written reason is required for every review decision.", "REVIEW_REASON_REQUIRED");
  }
  const { rows } = await db.query<{
    id: string; status: string; requires_dual_control: boolean; first_approval_by: string | null;
    reason_code_at_open: string; verification_attempt_id: string; environment_id: string;
  }>(
    `SELECT r.id, r.status, r.requires_dual_control, r.first_approval_by, r.reason_code_at_open,
            r.verification_attempt_id, v.environment_id
     FROM review_cases r JOIN verification_attempts v ON v.id = r.verification_attempt_id
     WHERE r.id = $1 AND r.organisation_id = $2 AND r.status = 'open'`,
    [reviewCaseId, organisationId],
  );
  const reviewCase = rows[0];
  if (!reviewCase) throw new VerificationError("No open review case found.", "NOT_FOUND", 404);

  if (reviewCase.requires_dual_control && !reviewCase.first_approval_by) {
    await db.query(
      `UPDATE review_cases SET first_approval_by = $2, first_approval_outcome = $3,
         first_approval_reason = $4, first_approval_at = now() WHERE id = $1`,
      [reviewCaseId, ctx.userId, outcome, reason.trim()],
    );
    await appendAudit(db, {
      organisationId, actorType: "user", actorId: ctx.userId, action: "review.first_approval",
      resourceType: "review_case", resourceId: reviewCaseId, outcome: "success",
      details: { outcome, reasonCodeAtOpen: reviewCase.reason_code_at_open },
    });
    return { status: "awaiting_second_approval", final: false };
  }

  if (reviewCase.requires_dual_control && reviewCase.first_approval_by === ctx.userId) {
    await appendAudit(db, {
      organisationId, actorType: "user", actorId: ctx.userId, action: "review.self_confirmation_refused",
      resourceType: "review_case", resourceId: reviewCaseId, outcome: "denied",
    });
    throw new VerificationError("Dual control requires a second, different reviewer.", "DUAL_CONTROL_SELF_REFUSED", 403);
  }

  await db.query(
    `UPDATE review_cases SET status = $2, decided_by = $3, decided_reason = $4, decided_at = now() WHERE id = $1`,
    [reviewCaseId, outcome, ctx.userId, reason.trim()],
  );
  await appendAudit(db, {
    organisationId, actorType: "user", actorId: ctx.userId, action: "review.decided",
    resourceType: "review_case", resourceId: reviewCaseId, outcome: "success",
    details: {
      outcome, dualControl: reviewCase.requires_dual_control,
      firstApprovalBy: reviewCase.first_approval_by ?? undefined,
      reasonCodeAtOpen: reviewCase.reason_code_at_open,
    },
  });
  await enqueueWebhook(db, organisationId, reviewCase.environment_id, "verification.completed", {
    verificationId: reviewCase.verification_attempt_id, decision: outcome,
    reasonCode: "HUMAN_REVIEW_DECISION", reviewCaseId,
  });
  return { status: outcome, final: true };
}

/**
 * Escalate a REJECTED LIVENESS_FAILED verification into a dual-control
 * exception review. Refused unless the tenant explicitly enabled
 * allow_liveness_exception. The escalation itself is audited.
 */
export async function escalateLivenessException(
  db: Db, ctx: AuthContext, organisationId: string, verificationId: string, justification: string,
): Promise<string> {
  await authorize(db, ctx, organisationId, "reviews:decide");
  if (!justification || justification.trim().length < 10) {
    throw new VerificationError("A written justification is required for a liveness exception.", "REVIEW_REASON_REQUIRED");
  }
  const setting = await db.query<{ allow_liveness_exception: boolean; review_sla_minutes: number }>(
    `SELECT allow_liveness_exception, review_sla_minutes FROM org_settings WHERE organisation_id = $1`,
    [organisationId],
  );
  if (!setting.rows[0]?.allow_liveness_exception) {
    await appendAudit(db, {
      organisationId, actorType: "user", actorId: ctx.userId, action: "review.liveness_exception_refused",
      resourceType: "verification_attempt", resourceId: verificationId, outcome: "denied",
    });
    throw new VerificationError(
      "This organisation has not enabled the liveness exception policy. A confirmed liveness failure is final.",
      "LIVENESS_EXCEPTION_DISABLED", 403,
    );
  }
  const attempt = await db.query<{ id: string; reason_code: string }>(
    `SELECT id, reason_code FROM verification_attempts
     WHERE id = $1 AND organisation_id = $2 AND decision = 'rejected' AND reason_code = 'LIVENESS_FAILED'`,
    [verificationId, organisationId],
  );
  if (!attempt.rows[0]) throw new VerificationError("Only rejected LIVENESS_FAILED attempts can be escalated.", "NOT_ESCALATABLE", 409);
  const existing = await db.query(`SELECT 1 FROM review_cases WHERE verification_attempt_id = $1`, [verificationId]);
  if (existing.rows.length > 0) throw new VerificationError("A review case already exists for this verification.", "ALREADY_ESCALATED", 409);

  const id = randomUUID();
  const sla = setting.rows[0].review_sla_minutes;
  await db.query(
    `INSERT INTO review_cases (id, organisation_id, verification_attempt_id, reason_code_at_open,
       risk_level, requires_dual_control, sla_due_at)
     VALUES ($1,$2,$3,'LIVENESS_EXCEPTION','high',TRUE, now() + ($4 || ' minutes')::interval)`,
    [id, organisationId, verificationId, String(sla)],
  );
  await appendAudit(db, {
    organisationId, actorType: "user", actorId: ctx.userId, action: "review.liveness_exception_opened",
    resourceType: "review_case", resourceId: id, outcome: "success",
    details: { verificationId, justificationLength: justification.trim().length },
  });
  return id;
}

/* ------------------- quality feedback loop ------------------- */

/** Safe end-user retry tips per capture failure reason. No scores, no internals. */
export const RETRY_TIPS: Record<string, string> = {
  FACE_NOT_DETECTED: "Hold the device at eye level and make sure your whole face is visible.",
  CAPTURE_QUALITY_INSUFFICIENT: "Find even, natural light and keep the camera still for a moment.",
  DOC_CAPTURE_QUALITY: "Place the document on a flat surface in good light and avoid glare.",
  DOC_EXPIRED: "This document appears to be expired. Please use a valid document.",
  DOC_CLASS_UNKNOWN: "Use a supported identity document and capture the photo page fully.",
};

export async function getCaptureFeedbackSummary(db: Db, ctx: AuthContext, organisationId: string, days = 7) {
  await authorize(db, ctx, organisationId, "audit:read");
  const { rows } = await db.query<{ reason_code: string; count: string }>(
    `SELECT reason_code, COUNT(*)::text AS count FROM verification_attempts
     WHERE organisation_id = $1 AND decision <> 'approved' AND created_at > now() - ($2 || ' days')::interval
     GROUP BY reason_code ORDER BY COUNT(*) DESC`,
    [organisationId, String(days)],
  );
  return rows.map((r) => ({
    reasonCode: r.reason_code,
    count: Number(r.count),
    retryTip: RETRY_TIPS[r.reason_code] ?? null,
  }));
}
