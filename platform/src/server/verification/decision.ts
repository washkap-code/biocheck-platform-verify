/**
 * Decision policy — mirrors biocheck_engine/policy.py semantics exactly.
 * Thresholds come only from an approved, immutable policy version; nothing is
 * hard-coded from a vendor. Every outcome carries a machine-readable reason
 * code and a human-safe message (no scores, no technical detail leakage).
 */

export type Decision = "approved" | "review" | "rejected";

export interface PolicyRow {
  id: string;
  version: number;
  min_quality: number;
  max_pose_degrees: number;
  max_occlusion: number;
  min_liveness: number;
  approve_similarity: number;
  review_similarity: number;
}

export const REASON_MESSAGES: Record<string, string> = {
  FACE_NOT_DETECTED: "We could not detect a face. Please try again in better light.",
  CAPTURE_QUALITY_INSUFFICIENT: "The capture quality was not sufficient. A specialist will review, or you can try again.",
  LIVENESS_FAILED: "We could not confirm the capture was live. Verification was not approved.",
  MATCH_CONFIRMED: "Identity verified.",
  MATCH_REQUIRES_HUMAN_REVIEW: "Your verification needs a quick manual review.",
  MATCH_NOT_CONFIRMED: "We could not confirm a match. Verification was not approved.",
  REFERENCE_NOT_FOUND: "No enrolment was found for this profile.",
  MODEL_VERSION_MISMATCH: "Your verification needs a quick manual review.",
  MODEL_NOT_APPROVED: "Your verification needs a quick manual review.",
  CONSENT_MISSING: "Verification requires an active consent record.",
  CONSENT_WITHDRAWN: "Consent for this profile has been withdrawn.",
  SERVICE_UNAVAILABLE: "The verification service is temporarily unavailable. Please try again shortly.",
  RISK_SIGNAL_REVIEW: "Your verification needs a quick manual review.",
};

export interface DecisionInput {
  faceDetected: boolean;
  quality: number;
  pose: number;
  occlusion: number;
  isLive: boolean;
  liveness: number;
  similarity: number;
}

export function decide(policy: PolicyRow, input: DecisionInput): { decision: Decision; reasonCode: string } {
  if (!input.faceDetected) return { decision: "rejected", reasonCode: "FACE_NOT_DETECTED" };
  if (
    input.quality < policy.min_quality ||
    Math.abs(input.pose) > policy.max_pose_degrees ||
    input.occlusion > policy.max_occlusion
  ) {
    return { decision: "review", reasonCode: "CAPTURE_QUALITY_INSUFFICIENT" };
  }
  if (!input.isLive || input.liveness < policy.min_liveness) {
    return { decision: "rejected", reasonCode: "LIVENESS_FAILED" };
  }
  if (input.similarity >= policy.approve_similarity) return { decision: "approved", reasonCode: "MATCH_CONFIRMED" };
  if (input.similarity >= policy.review_similarity) {
    return { decision: "review", reasonCode: "MATCH_REQUIRES_HUMAN_REVIEW" };
  }
  return { decision: "rejected", reasonCode: "MATCH_NOT_CONFIRMED" };
}

export function humanMessage(reasonCode: string): string {
  return REASON_MESSAGES[reasonCode] ?? "Your verification needs a quick manual review.";
}
