/**
 * Consent-led 1:1 verification workflow. Enterprise identity verification,
 * NOT surveillance: no 1:N search, no watchlists, no background matching.
 *
 * Every outcome is recorded with policy version, model identity, reason code
 * and an audit-chain hash. Fail-closed everywhere: liveness failure and
 * missing consent reject; unknown model hash, provider outage, poor quality
 * and ambiguous similarity route to human review — never silent approval.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import type { ApiKeyPrincipal } from "../apikeys/service";
import { appendAudit } from "../audit/service";
import { authorize, type AuthContext } from "../authz/policy";
import { randomToken, sha256Hex } from "../security/crypto";
import { enqueueWebhook } from "../webhooks/service";
import { decide, humanMessage, type Decision, type PolicyRow } from "./decision";
import {
  assertModelApproved, ModelNotApprovedError, ProviderUnavailableError, type BiometricProvider,
} from "./providers";

const CAPTURE_SESSION_MINUTES = 10;
const CHALLENGES = ["turn-head-left", "turn-head-right", "blink-twice", "look-up", "smile"] as const;

export class VerificationError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) {
    super(message);
  }
}

/* ----------------------------- subjects & consent ----------------------------- */

export async function ensureSubject(db: Db, principal: ApiKeyPrincipal, subjectRef: string): Promise<string> {
  if (!subjectRef || subjectRef.length > 128) throw new VerificationError("subjectRef is required (max 128 chars).", "INVALID_SUBJECT_REF");
  if (/^\d{6,}$/.test(subjectRef)) {
    throw new VerificationError("subjectRef must be an opaque reference, not a numeric identity number.", "INVALID_SUBJECT_REF");
  }
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM subjects WHERE project_id = $1 AND subject_ref = $2`,
    [principal.projectId, subjectRef],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  await db.query(
    `INSERT INTO subjects (id, organisation_id, project_id, subject_ref) VALUES ($1,$2,$3,$4)`,
    [id, principal.organisationId, principal.projectId, subjectRef],
  );
  return id;
}

export interface ConsentInput {
  noticeVersion: string;
  purpose: string;
  lawfulBasis: string;       // tenant-configured policy field; no legal conclusion in code
  retentionExpiresAt?: Date;
  evidenceRef?: string;
}

export async function recordConsent(db: Db, principal: ApiKeyPrincipal, subjectId: string, input: ConsentInput): Promise<string> {
  if (!input.noticeVersion || !input.purpose || !input.lawfulBasis) {
    throw new VerificationError("noticeVersion, purpose and lawfulBasis are required.", "CONSENT_INVALID");
  }
  const id = randomUUID();
  await db.query(
    `INSERT INTO consent_receipts (id, organisation_id, subject_id, notice_version, purpose, lawful_basis, retention_expires_at, evidence_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, principal.organisationId, subjectId, input.noticeVersion, input.purpose, input.lawfulBasis,
     input.retentionExpiresAt ?? null, input.evidenceRef ?? null],
  );
  await appendAudit(db, {
    organisationId: principal.organisationId, actorType: "api_key", actorId: principal.apiKeyId,
    action: "consent.recorded", resourceType: "consent_receipt", resourceId: id, outcome: "success",
    details: { noticeVersion: input.noticeVersion, purpose: input.purpose },
  });
  return id;
}

/** Withdrawal revokes all active templates for the subject and notifies the tenant. */
export async function withdrawConsent(db: Db, principal: ApiKeyPrincipal, consentId: string): Promise<void> {
  const { rows } = await db.query<{ id: string; subject_id: string; withdrawn_at: string | null }>(
    `SELECT id, subject_id, withdrawn_at FROM consent_receipts WHERE id = $1 AND organisation_id = $2`,
    [consentId, principal.organisationId],
  );
  const consent = rows[0];
  if (!consent) throw new VerificationError("Consent receipt not found.", "NOT_FOUND", 404);
  if (consent.withdrawn_at) return; // idempotent
  await db.query(`UPDATE consent_receipts SET withdrawn_at = now() WHERE id = $1`, [consentId]);
  await db.query(
    `UPDATE reference_templates SET status = 'revoked', revoked_at = now()
     WHERE consent_receipt_id = $1 AND status = 'active'`,
    [consentId],
  );
  await appendAudit(db, {
    organisationId: principal.organisationId, actorType: "api_key", actorId: principal.apiKeyId,
    action: "consent.withdrawn", resourceType: "consent_receipt", resourceId: consentId, outcome: "success",
  });
  await enqueueWebhook(db, principal.organisationId, principal.environmentId, "consent.withdrawn", {
    consentId, subjectId: consent.subject_id, withdrawnAt: new Date().toISOString(),
  });
}

/* ----------------------------- capture sessions ----------------------------- */

export interface CaptureSessionResult {
  captureSessionId: string;
  /** signed client token — shown once, never stored in plaintext */
  clientToken: string;
  challenge: string;
  expiresAt: string;
}

export async function createCaptureSession(
  db: Db, principal: ApiKeyPrincipal, purpose: "enrolment" | "verification", subjectId?: string,
): Promise<CaptureSessionResult> {
  const id = randomUUID();
  const nonce = randomToken(16);
  const secret = randomToken(24);
  const clientToken = `bcs_${id}.${nonce}.${secret}`; // id + nonce + secret, verified by hash
  const challenge = CHALLENGES[Math.floor(Math.random() * CHALLENGES.length)];
  await db.query(
    `INSERT INTO capture_sessions (id, organisation_id, project_id, environment_id, purpose, subject_id,
       token_hash, nonce, challenge, api_key_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + interval '${CAPTURE_SESSION_MINUTES} minutes')`,
    [id, principal.organisationId, principal.projectId, principal.environmentId, purpose,
     subjectId ?? null, sha256Hex(clientToken), nonce, challenge, principal.apiKeyId],
  );
  const { rows } = await db.query<{ expires_at: string }>(`SELECT expires_at FROM capture_sessions WHERE id = $1`, [id]);
  return { captureSessionId: id, clientToken, challenge, expiresAt: rows[0].expires_at };
}

interface CaptureSessionRow {
  id: string; organisation_id: string; project_id: string; environment_id: string;
  purpose: string; subject_id: string | null; nonce: string; challenge: string; status: string;
}

/** One-use consumption: pending + unexpired + token match, atomically marked used. */
async function consumeCaptureSession(db: Db, principal: ApiKeyPrincipal, clientToken: string, purpose: string): Promise<CaptureSessionRow> {
  const { rows } = await db.query<CaptureSessionRow>(
    `UPDATE capture_sessions SET status = 'used', used_at = now()
     WHERE token_hash = $1 AND organisation_id = $2 AND environment_id = $3
       AND status = 'pending' AND expires_at > now()
     RETURNING id, organisation_id, project_id, environment_id, purpose, subject_id, nonce, challenge, status`,
    [sha256Hex(clientToken), principal.organisationId, principal.environmentId],
  );
  const session = rows[0];
  if (!session) throw new VerificationError("Capture session is invalid, expired or already used.", "CAPTURE_SESSION_INVALID", 409);
  if (session.purpose !== purpose) throw new VerificationError(`Capture session was issued for ${session.purpose}.`, "CAPTURE_SESSION_PURPOSE_MISMATCH", 409);
  return session;
}

/* ----------------------------- policies ----------------------------- */

export const PLATFORM_DEFAULT_POLICY = {
  name: "biocheck-1to1-default", version: 1, min_quality: 0.72, max_pose_degrees: 25,
  max_occlusion: 0.2, min_liveness: 0.93, approve_similarity: 0.74, review_similarity: 0.62,
};

export async function ensureDefaultPolicy(db: Db): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM verification_policies WHERE organisation_id IS NULL AND name = $1 AND version = $2`,
    [PLATFORM_DEFAULT_POLICY.name, PLATFORM_DEFAULT_POLICY.version],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  const p = PLATFORM_DEFAULT_POLICY;
  await db.query(
    `INSERT INTO verification_policies (id, organisation_id, name, version, min_quality, max_pose_degrees,
       max_occlusion, min_liveness, approve_similarity, review_similarity, approved_by)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, 'platform-default')`,
    [id, p.name, p.version, p.min_quality, p.max_pose_degrees, p.max_occlusion, p.min_liveness,
     p.approve_similarity, p.review_similarity],
  );
  return id;
}

async function getActivePolicy(db: Db, environmentId: string): Promise<PolicyRow> {
  const { rows } = await db.query<PolicyRow & { active_policy_id: string | null }>(
    `SELECT p.id, p.version, p.min_quality, p.max_pose_degrees, p.max_occlusion, p.min_liveness,
            p.approve_similarity, p.review_similarity
     FROM environments e JOIN verification_policies p ON p.id = e.active_policy_id
     WHERE e.id = $1`,
    [environmentId],
  );
  if (rows[0]) return rows[0];
  const defaultId = await ensureDefaultPolicy(db);
  const fallback = await db.query<PolicyRow>(`SELECT * FROM verification_policies WHERE id = $1`, [defaultId]);
  return fallback.rows[0];
}

/* ----------------------------- enrolment ----------------------------- */

export interface EnrolmentInput {
  subjectRef: string;
  captureSessionToken: string;
  imageBytes: Uint8Array;
  consent: ConsentInput;
  sourceType?: "live_capture" | "document_portrait";
}

export async function enrolSubject(db: Db, principal: ApiKeyPrincipal, provider: BiometricProvider, input: EnrolmentInput) {
  const subjectId = await ensureSubject(db, principal, input.subjectRef);
  const session = await consumeCaptureSession(db, principal, input.captureSessionToken, "enrolment");
  const consentId = await recordConsent(db, principal, subjectId, input.consent);

  const analysis = await provider.analyseCapture(input.imageBytes, session.nonce);
  await assertModelApproved(db, analysis.modelId, analysis.modelSha256, "face_embedding");
  await assertModelApproved(db, analysis.padModelId, analysis.padModelSha256, "passive_pad");

  const policy = await getActivePolicy(db, principal.environmentId);
  if (!analysis.quality.faceDetected || analysis.quality.qualityScore < policy.min_quality) {
    throw new VerificationError("Reference capture quality is insufficient for enrolment.", "CAPTURE_QUALITY_INSUFFICIENT", 422);
  }
  if (!analysis.liveness.isLive || analysis.liveness.score < policy.min_liveness) {
    throw new VerificationError("Liveness could not be confirmed for enrolment.", "LIVENESS_FAILED", 422);
  }

  const template = await provider.createTemplate(analysis.captureRef);
  const templateId = randomUUID();
  await db.query(
    `INSERT INTO reference_templates (id, organisation_id, project_id, subject_id, consent_receipt_id,
       template_ciphertext, model_id, model_sha256, source_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [templateId, principal.organisationId, principal.projectId, subjectId, consentId,
     template.templateCiphertext, template.modelId, template.modelSha256, input.sourceType ?? "live_capture"],
  );
  const auditHash = await appendAudit(db, {
    organisationId: principal.organisationId, actorType: "api_key", actorId: principal.apiKeyId,
    action: "subject.enrolled", resourceType: "reference_template", resourceId: templateId, outcome: "success",
    details: { modelId: template.modelId, sourceType: input.sourceType ?? "live_capture", policyVersion: policy.version },
  });
  return { subjectId, templateId, consentId, auditHash };
}

/* ----------------------------- verification ----------------------------- */

export interface VerificationOutcome {
  verificationId: string;
  decision: Decision;
  reasonCode: string;
  message: string;
  reviewCaseId?: string;
}

export async function verifySubject(
  db: Db, principal: ApiKeyPrincipal, provider: BiometricProvider,
  input: { subjectRef: string; captureSessionToken: string; imageBytes: Uint8Array; requestId?: string },
): Promise<VerificationOutcome> {
  const session = await consumeCaptureSession(db, principal, input.captureSessionToken, "verification");
  const policy = await getActivePolicy(db, principal.environmentId);

  const subject = await db.query<{ id: string }>(
    `SELECT id FROM subjects WHERE project_id = $1 AND subject_ref = $2`,
    [principal.projectId, input.subjectRef],
  );
  const subjectId = subject.rows[0]?.id;

  const record = async (
    decision: Decision, reasonCode: string,
    extra: { similarity?: number; liveness?: number; quality?: number; modelId?: string; modelSha256?: string } = {},
  ): Promise<VerificationOutcome> => {
    const id = randomUUID();
    const sid = subjectId ?? (await ensureSubject(db, principal, input.subjectRef));
    const auditHash = await appendAudit(db, {
      organisationId: principal.organisationId, actorType: "api_key", actorId: principal.apiKeyId,
      action: "verification.completed", resourceType: "verification_attempt", resourceId: id,
      outcome: decision === "approved" ? "success" : decision === "review" ? "denied" : "failure",
      requestId: input.requestId ?? null,
      details: { decision, reasonCode, policyVersion: policy.version, scoreBand: decision },
    });
    await db.query(
      `INSERT INTO verification_attempts (id, organisation_id, project_id, environment_id, subject_id,
         capture_session_id, decision, reason_code, human_message, similarity, liveness_score, quality_score,
         model_id, model_sha256, policy_id, policy_version, audit_hash, request_id, api_key_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [id, principal.organisationId, principal.projectId, principal.environmentId, sid, session.id,
       decision, reasonCode, humanMessage(reasonCode), extra.similarity ?? null, extra.liveness ?? null,
       extra.quality ?? null, extra.modelId ?? null, extra.modelSha256 ?? null, policy.id ?? null,
       policy.version, auditHash, input.requestId ?? null, principal.apiKeyId],
    );
    let reviewCaseId: string | undefined;
    if (decision === "review") {
      reviewCaseId = randomUUID();
      // Risk and SLA: model-integrity reasons are high risk; SLA from tenant settings (default 240 min).
      const highRisk = reasonCode === "MODEL_VERSION_MISMATCH" || reasonCode === "MODEL_NOT_APPROVED";
      const sla = await db.query<{ review_sla_minutes: number }>(
        `SELECT review_sla_minutes FROM org_settings WHERE organisation_id = $1`, [principal.organisationId],
      );
      const slaMinutes = sla.rows[0]?.review_sla_minutes ?? 240;
      await db.query(
        `INSERT INTO review_cases (id, organisation_id, verification_attempt_id, reason_code_at_open,
           risk_level, requires_dual_control, sla_due_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval)`,
        [reviewCaseId, principal.organisationId, id, reasonCode,
         highRisk ? "high" : "standard", highRisk, String(slaMinutes)],
      );
      await enqueueWebhook(db, principal.organisationId, principal.environmentId, "verification.review_required", {
        verificationId: id, reviewCaseId, reasonCode,
      });
    }
    await enqueueWebhook(db, principal.organisationId, principal.environmentId, "verification.completed", {
      verificationId: id, decision, reasonCode,
    });
    return { verificationId: id, decision, reasonCode, message: humanMessage(reasonCode), reviewCaseId };
  };

  // Reference + consent state first — cheap rejections without touching biometrics.
  if (!subjectId) return record("rejected", "REFERENCE_NOT_FOUND");
  const templateRow = await db.query<{
    id: string; template_ciphertext: string; model_id: string; model_sha256: string; withdrawn_at: string | null;
  }>(
    `SELECT t.id, t.template_ciphertext, t.model_id, t.model_sha256, c.withdrawn_at
     FROM reference_templates t JOIN consent_receipts c ON c.id = t.consent_receipt_id
     WHERE t.subject_id = $1 AND t.project_id = $2 AND t.status = 'active'
       AND (t.expires_at IS NULL OR t.expires_at > now())
     ORDER BY t.created_at DESC LIMIT 1`,
    [subjectId, principal.projectId],
  );
  const template = templateRow.rows[0];
  if (!template) return record("rejected", "REFERENCE_NOT_FOUND");
  if (template.withdrawn_at) return record("rejected", "CONSENT_WITHDRAWN");

  // Provider analysis — fail closed to REVIEW on outage or unapproved model.
  let analysis;
  try {
    analysis = await provider.analyseCapture(input.imageBytes, session.nonce);
    await assertModelApproved(db, analysis.modelId, analysis.modelSha256, "face_embedding");
    await assertModelApproved(db, analysis.padModelId, analysis.padModelSha256, "passive_pad");
  } catch (err) {
    if (err instanceof ModelNotApprovedError) return record("review", "MODEL_NOT_APPROVED");
    if (err instanceof ProviderUnavailableError) return record("review", "SERVICE_UNAVAILABLE");
    throw err;
  }

  if (template.model_id !== analysis.modelId || template.model_sha256 !== analysis.modelSha256) {
    return record("review", "MODEL_VERSION_MISMATCH", { modelId: analysis.modelId, modelSha256: analysis.modelSha256 });
  }

  let similarity: number;
  try {
    ({ similarity } = await provider.compareTemplates(template.template_ciphertext, analysis.captureRef));
  } catch (err) {
    if (err instanceof ProviderUnavailableError) return record("review", "SERVICE_UNAVAILABLE");
    throw err;
  }

  let { decision, reasonCode } = decide(policy, {
    faceDetected: analysis.quality.faceDetected,
    quality: analysis.quality.qualityScore,
    pose: analysis.quality.poseDegrees,
    occlusion: analysis.quality.occlusionScore,
    isLive: analysis.liveness.isLive,
    liveness: analysis.liveness.score,
    similarity,
  });
  // Fraud risk signals may DOWNGRADE an approval to human review — never the
  // other way round, and never an automatic rejection of the person.
  if (decision === "approved") {
    const { shouldRouteToReview } = await import("../fraud/service");
    if (await shouldRouteToReview(db, principal.organisationId, subjectId)) {
      decision = "review";
      reasonCode = "RISK_SIGNAL_REVIEW";
    }
  }
  return record(decision, reasonCode, {
    similarity, liveness: analysis.liveness.score, quality: analysis.quality.qualityScore,
    modelId: analysis.modelId, modelSha256: analysis.modelSha256,
  });
}

export async function getVerification(db: Db, principal: ApiKeyPrincipal, verificationId: string) {
  const { rows } = await db.query(
    `SELECT v.id, v.decision, v.reason_code, v.human_message, v.policy_version, v.created_at,
            s.subject_ref, r.id AS review_case_id, r.status AS review_status
     FROM verification_attempts v
     JOIN subjects s ON s.id = v.subject_id
     LEFT JOIN review_cases r ON r.verification_attempt_id = v.id
     WHERE v.id = $1 AND v.organisation_id = $2 AND v.project_id = $3`,
    [verificationId, principal.organisationId, principal.projectId],
  );
  if (!rows[0]) throw new VerificationError("Verification not found.", "NOT_FOUND", 404);
  return rows[0];
}

/* ----------------------------- human review ----------------------------- */

/**
 * A decision on a review case requires a NAMED human reviewer with the
 * reviews:decide permission and an explicit reason. A confirmed liveness
 * failure can never be overridden here (it is rejected, not reviewable).
 */
export async function decideReviewCase(
  db: Db, ctx: AuthContext, organisationId: string, verificationId: string,
  outcome: "approved" | "rejected", reason: string,
) {
  await authorize(db, ctx, organisationId, "reviews:decide");
  if (!reason || reason.trim().length < 5) {
    throw new VerificationError("A written reason is required for every review decision.", "REVIEW_REASON_REQUIRED");
  }
  const { rows } = await db.query<{ id: string; reason_code_at_open: string; environment_id: string }>(
    `SELECT r.id, r.reason_code_at_open, v.environment_id
     FROM review_cases r JOIN verification_attempts v ON v.id = r.verification_attempt_id
     WHERE r.verification_attempt_id = $1 AND r.organisation_id = $2 AND r.status = 'open'`,
    [verificationId, organisationId],
  );
  const reviewCase = rows[0];
  if (!reviewCase) throw new VerificationError("No open review case for this verification.", "NOT_FOUND", 404);
  await db.query(
    `UPDATE review_cases SET status = $2, decided_by = $3, decided_reason = $4, decided_at = now() WHERE id = $1`,
    [reviewCase.id, outcome, ctx.userId, reason.trim()],
  );
  const auditHash = await appendAudit(db, {
    organisationId, actorType: "user", actorId: ctx.userId, action: "review.decided",
    resourceType: "review_case", resourceId: reviewCase.id, outcome: "success",
    details: { outcome, reasonCodeAtOpen: reviewCase.reason_code_at_open },
  });
  await enqueueWebhook(db, organisationId, reviewCase.environment_id, "verification.completed", {
    verificationId, decision: outcome, reasonCode: "HUMAN_REVIEW_DECISION", reviewCaseId: reviewCase.id,
  });
  return { reviewCaseId: reviewCase.id, outcome, auditHash };
}
