/**
 * Document-assisted verification workflow.
 * Consumes a capture session, runs the staged provider, MASKS the document
 * number immediately (full value never persists), optionally retains
 * encrypted evidence per tenant policy, and can enrol the extracted portrait
 * as a document_portrait reference template.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import type { ApiKeyPrincipal } from "../apikeys/service";
import { appendAudit } from "../audit/service";
import { sha256Hex } from "../security/crypto";
import type { EvidenceService } from "../privacy/evidence";
import { maskDocumentNumber, type DocumentVerificationProvider, type DocumentAnalysis } from "./provider";

export interface DocumentCheckOutcome {
  documentCheckId: string;
  overall: "pass" | "review" | "fail";
  reasonCode: string;
  stages: DocumentAnalysis["stages"];
  documentClass: string;
  docNumberMasked: string | null;
  portraitCaptureRef: string | null;   // for immediate enrolment only; not persisted
}

function deriveOutcome(analysis: DocumentAnalysis): { overall: "pass" | "review" | "fail"; reasonCode: string } {
  const s = analysis.stages;
  if (s.captureQuality === "fail") return { overall: "fail", reasonCode: "DOC_CAPTURE_QUALITY" };
  if (s.expiry === "fail") return { overall: "fail", reasonCode: "DOC_EXPIRED" };
  if (s.tamper === "fail") return { overall: "review", reasonCode: "DOC_TAMPER_SIGNALS" };
  if (s.classification === "fail") return { overall: "review", reasonCode: "DOC_CLASS_UNKNOWN" };
  if (s.ocrMrz === "fail" || s.portrait === "fail") return { overall: "review", reasonCode: "DOC_EXTRACTION_INCOMPLETE" };
  if (Object.values(s).includes("warn")) return { overall: "review", reasonCode: "DOC_PARTIAL_CONFIDENCE" };
  return { overall: "pass", reasonCode: "DOC_CHECKS_PASSED" };
}

export async function runDocumentCheck(
  db: Db, principal: ApiKeyPrincipal, provider: DocumentVerificationProvider,
  input: {
    imageBytes: Uint8Array;
    subjectId?: string;
    captureSessionId?: string;
    /** Tenant evidence policy: when provided, the ORIGINAL image is retained encrypted. */
    evidence?: { service: EvidenceService; purpose: string; retentionExpiresAt: Date };
  },
): Promise<DocumentCheckOutcome> {
  const analysis = await provider.analyseDocument(input.imageBytes);
  const { overall, reasonCode } = deriveOutcome(analysis);
  const masked = maskDocumentNumber(analysis.documentNumber);
  // The full number's lifetime ends here.

  let evidenceId: string | null = null;
  if (input.evidence) {
    evidenceId = await input.evidence.service.retain({
      organisationId: principal.organisationId,
      subjectId: input.subjectId,
      relatedType: "document_check",
      purpose: input.evidence.purpose,
      retentionExpiresAt: input.evidence.retentionExpiresAt,
      bytes: Buffer.from(input.imageBytes),
      createdBy: principal.apiKeyId,
    });
  }

  const id = randomUUID();
  const auditHash = await appendAudit(db, {
    organisationId: principal.organisationId, actorType: "api_key", actorId: principal.apiKeyId,
    action: "document.checked", resourceType: "document_check", resourceId: id,
    outcome: overall === "pass" ? "success" : overall === "review" ? "denied" : "failure",
    // Broad audit record: outcomes only. No document numbers, masked or not.
    details: { overall, reasonCode, documentClass: analysis.documentClass, stageSummary: sha256Hex(JSON.stringify(analysis.stages)).slice(0, 12) },
  });
  await db.query(
    `INSERT INTO document_checks (id, organisation_id, project_id, subject_id, capture_session_id, provider_id,
       stage_capture_quality, stage_classification, stage_ocr_mrz, stage_expiry, stage_tamper, stage_portrait,
       document_class, issuing_country, doc_number_masked, expiry_date, tamper_signals, overall, reason_code,
       evidence_id, audit_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [id, principal.organisationId, principal.projectId, input.subjectId ?? null, input.captureSessionId ?? null,
     analysis.providerId, analysis.stages.captureQuality, analysis.stages.classification, analysis.stages.ocrMrz,
     analysis.stages.expiry, analysis.stages.tamper, analysis.stages.portrait, analysis.documentClass,
     analysis.issuingCountry, masked, analysis.expiryDate, analysis.tamperSignals, overall, reasonCode,
     evidenceId, auditHash],
  );

  return {
    documentCheckId: id, overall, reasonCode, stages: analysis.stages,
    documentClass: analysis.documentClass, docNumberMasked: masked,
    portraitCaptureRef: overall === "fail" ? null : analysis.portraitCaptureRef,
  };
}

/** Console view: minimised/redacted fields only. */
export async function listDocumentChecks(db: Db, organisationId: string, limit = 100) {
  const { rows } = await db.query(
    `SELECT id, document_class, issuing_country, doc_number_masked, overall, reason_code,
            tamper_signals, created_at
     FROM document_checks WHERE organisation_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [organisationId, Math.min(limit, 500)],
  );
  return rows;
}
