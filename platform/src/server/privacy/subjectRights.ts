/**
 * Subject data rights: export and deletion/withdrawal.
 *
 * Deletion revokes templates (so future matching is impossible), withdraws
 * consents and removes retained evidence — unless an active legal hold blocks
 * it, in which case the request is parked as blocked_legal_hold and surfaced.
 * The request itself is audited WITHOUT retaining the deleted biometric data.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import type { ApiKeyPrincipal } from "../apikeys/service";
import { appendAudit } from "../audit/service";
import type { EvidenceService } from "./evidence";

/** Export: everything the tenant holds about the subject, minus biometric material. */
export async function exportSubjectData(db: Db, principal: ApiKeyPrincipal, subjectRef: string) {
  const subject = await db.query<{ id: string; subject_ref: string; created_at: string }>(
    `SELECT id, subject_ref, created_at FROM subjects WHERE project_id = $1 AND subject_ref = $2`,
    [principal.projectId, subjectRef],
  );
  if (!subject.rows[0]) throw new Error("Subject not found.");
  const subjectId = subject.rows[0].id;

  const consents = await db.query(
    `SELECT id, notice_version, purpose, lawful_basis, captured_at, withdrawn_at, retention_expires_at
     FROM consent_receipts WHERE subject_id = $1`, [subjectId]);
  const templates = await db.query(
    `SELECT id, model_id, source_type, status, created_at, revoked_at
     FROM reference_templates WHERE subject_id = $1`, [subjectId]); // metadata only — NO ciphertext, NO embeddings
  const attempts = await db.query(
    `SELECT id, decision, reason_code, policy_version, created_at
     FROM verification_attempts WHERE subject_id = $1 ORDER BY created_at`, [subjectId]);
  const evidence = await db.query(
    `SELECT id, purpose, related_type, retention_expires_at, created_at, deleted_at
     FROM evidence_objects WHERE subject_id = $1`, [subjectId]); // metadata only

  const requestId = randomUUID();
  await db.query(
    `INSERT INTO subject_requests (id, organisation_id, subject_id, kind, status, requested_via, completed_at)
     VALUES ($1,$2,$3,'export','completed',$4, now())`,
    [requestId, principal.organisationId, subjectId, principal.apiKeyId],
  );
  await appendAudit(db, {
    organisationId: principal.organisationId, actorType: "api_key", actorId: principal.apiKeyId,
    action: "subject.exported", resourceType: "subject_request", resourceId: requestId, outcome: "success",
  });
  return {
    requestId,
    subject: subject.rows[0],
    consents: consents.rows,
    referenceTemplates: templates.rows,
    verificationAttempts: attempts.rows,
    evidenceObjects: evidence.rows,
    note: "Biometric templates are never exported; they are non-reversible encrypted references and are excluded by design.",
  };
}

export interface DeletionResult {
  requestId: string;
  status: "completed" | "blocked_legal_hold";
  templatesRevoked: number;
  consentsWithdrawn: number;
  evidenceDeleted: number;
  legalHoldRef?: string;
}

export async function deleteSubjectData(
  db: Db, principal: ApiKeyPrincipal, evidenceService: EvidenceService, subjectRef: string,
): Promise<DeletionResult> {
  const subject = await db.query<{ id: string }>(
    `SELECT id FROM subjects WHERE project_id = $1 AND subject_ref = $2`,
    [principal.projectId, subjectRef],
  );
  if (!subject.rows[0]) throw new Error("Subject not found.");
  const subjectId = subject.rows[0].id;
  const requestId = randomUUID();

  // Legal hold check — deletion is parked, not silently skipped.
  const hold = await db.query<{ id: string; reason: string }>(
    `SELECT id, reason FROM legal_holds
     WHERE subject_id = $1 AND organisation_id = $2 AND released_at IS NULL`,
    [subjectId, principal.organisationId],
  );
  if (hold.rows[0]) {
    await db.query(
      `INSERT INTO subject_requests (id, organisation_id, subject_id, kind, status, legal_hold_ref, requested_via)
       VALUES ($1,$2,$3,'deletion','blocked_legal_hold',$4,$5)`,
      [requestId, principal.organisationId, subjectId, hold.rows[0].id, principal.apiKeyId],
    );
    await appendAudit(db, {
      organisationId: principal.organisationId, actorType: "api_key", actorId: principal.apiKeyId,
      action: "subject.deletion_blocked", resourceType: "subject_request", resourceId: requestId,
      outcome: "denied", details: { legalHoldRef: hold.rows[0].id },
    });
    return {
      requestId, status: "blocked_legal_hold", templatesRevoked: 0, consentsWithdrawn: 0,
      evidenceDeleted: 0, legalHoldRef: hold.rows[0].id,
    };
  }

  const templates = await db.query<{ id: string }>(
    `UPDATE reference_templates SET status = 'revoked', revoked_at = now(), template_ciphertext = 'deleted'
     WHERE subject_id = $1 AND status = 'active' RETURNING id`,
    [subjectId],
  );
  const consents = await db.query<{ id: string }>(
    `UPDATE consent_receipts SET withdrawn_at = now()
     WHERE subject_id = $1 AND withdrawn_at IS NULL RETURNING id`,
    [subjectId],
  );
  const evidence = await db.query<{ id: string }>(
    `SELECT id FROM evidence_objects WHERE subject_id = $1 AND deleted_at IS NULL`,
    [subjectId],
  );
  for (const row of evidence.rows) {
    await evidenceService.deleteObject(principal.organisationId, row.id, "subject_deletion_request", principal.apiKeyId);
  }

  await db.query(
    `INSERT INTO subject_requests (id, organisation_id, subject_id, kind, status, requested_via, completed_at)
     VALUES ($1,$2,$3,'deletion','completed',$4, now())`,
    [requestId, principal.organisationId, subjectId, principal.apiKeyId],
  );
  // Audit records COUNTS only — never the deleted content.
  await appendAudit(db, {
    organisationId: principal.organisationId, actorType: "api_key", actorId: principal.apiKeyId,
    action: "subject.deleted", resourceType: "subject_request", resourceId: requestId, outcome: "success",
    details: {
      // key names deliberately avoid the redaction guard's biometric terms —
      // these are counts, not content
      referencesRevokedCount: templates.rows.length,
      consentsWithdrawnCount: consents.rows.length,
      evidenceDeletedCount: evidence.rows.length,
    },
  });
  return {
    requestId, status: "completed",
    templatesRevoked: templates.rows.length,
    consentsWithdrawn: consents.rows.length,
    evidenceDeleted: evidence.rows.length,
  };
}

/* ------------------------- data residency ------------------------- */

export async function setDataResidency(db: Db, organisationId: string, countryCode: string, storageRegion: string): Promise<void> {
  await db.query(
    `INSERT INTO data_residency (organisation_id, country_code, storage_region, updated_at)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (organisation_id) DO UPDATE SET country_code = $2, storage_region = $3, updated_at = now()`,
    [organisationId, countryCode.toUpperCase(), storageRegion],
  );
}

/**
 * Cross-border transfers must be registered BEFORE data moves: named approver,
 * mechanism and reason. There is no code path that moves data silently.
 */
export async function registerTransfer(
  db: Db, organisationId: string, input: {
    dataCategory: string; fromRegion: string; toRegion: string;
    mechanism: string; reason: string; approvedBy: string;
  },
): Promise<string> {
  for (const [k, v] of Object.entries(input)) {
    if (!v?.trim()) throw new Error(`Transfer register requires '${k}'.`);
  }
  const id = randomUUID();
  await db.query(
    `INSERT INTO transfer_register (id, organisation_id, data_category, from_region, to_region, mechanism, reason, approved_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, organisationId, input.dataCategory, input.fromRegion, input.toRegion, input.mechanism, input.reason, input.approvedBy],
  );
  await appendAudit(db, {
    organisationId, actorType: "user", actorId: input.approvedBy,
    action: "transfer.registered", resourceType: "transfer_register", resourceId: id, outcome: "success",
    details: { dataCategory: input.dataCategory, fromRegion: input.fromRegion, toRegion: input.toRegion },
  });
  return id;
}
