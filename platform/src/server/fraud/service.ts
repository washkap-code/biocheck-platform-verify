/**
 * Fraud controls.
 *
 * Boundary (non-negotiable): risk signals ROUTE TO HUMAN REVIEW only. They
 * never approve, never auto-reject a person, and never infer protected
 * traits or feed social/credit/health decisions.
 *
 * Replay protection (capture-session nonce + one-use tokens) lives in the
 * verification service; this module adds device/app attestation, velocity
 * anomaly indicators and duplicate-capture detection.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { sha256Hex } from "../security/crypto";
import { assertSafeDetails } from "../audit/service";
import type { RateLimitStore } from "../security/controls";

/* ------------------- device / app attestation ------------------- */

export interface AttestationResult {
  verdict: "trusted" | "untrusted" | "unknown";
  signals: string[];   // e.g. ["emulator_suspected"], never device fingerprints/PII
}

export interface DeviceAttestationAdapter {
  readonly adapterId: string;
  verify(attestationToken: string | null): Promise<AttestationResult>;
}

/** Dev/test adapter: trusts nothing blindly; parses synthetic tokens. Refuses production. */
export class NoopAttestationAdapter implements DeviceAttestationAdapter {
  readonly adapterId = "noop-dev-only";
  constructor() {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Production requires a real attestation adapter (Play Integrity / App Attest / WebAuthn).");
    }
  }
  async verify(attestationToken: string | null): Promise<AttestationResult> {
    if (!attestationToken) return { verdict: "unknown", signals: ["no_attestation_presented"] };
    if (attestationToken === "synthetic:untrusted") return { verdict: "untrusted", signals: ["synthetic_untrusted_token"] };
    return { verdict: "trusted", signals: [] };
  }
}

export async function recordAttestation(
  db: Db, organisationId: string, captureSessionId: string,
  adapter: DeviceAttestationAdapter, attestationToken: string | null,
): Promise<AttestationResult> {
  const result = await adapter.verify(attestationToken);
  await db.query(
    `INSERT INTO device_attestations (id, organisation_id, capture_session_id, adapter_id, verdict, signals)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), organisationId, captureSessionId, adapter.adapterId, result.verdict, result.signals],
  );
  if (result.verdict === "untrusted") {
    await recordRiskSignal(db, organisationId, {
      captureSessionId, kind: "attestation_untrusted", severity: "high",
      detail: { adapterId: adapter.adapterId, signals: result.signals },
    });
  }
  return result;
}

/* ------------------- risk signals ------------------- */

export interface RiskSignalInput {
  subjectId?: string;
  captureSessionId?: string;
  kind: string;
  severity: "info" | "elevated" | "high";
  detail?: Record<string, unknown>;
}

export async function recordRiskSignal(db: Db, organisationId: string, input: RiskSignalInput): Promise<string> {
  const detail = input.detail ?? {};
  assertSafeDetails(detail); // same guard as audit: no biometric/secret content in signals
  const id = randomUUID();
  await db.query(
    `INSERT INTO risk_signals (id, organisation_id, subject_id, capture_session_id, kind, severity, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, organisationId, input.subjectId ?? null, input.captureSessionId ?? null,
     input.kind, input.severity, JSON.stringify(detail)],
  );
  return id;
}

/**
 * Should this capture be routed to review? True when recent HIGH-severity
 * signals exist for the subject/session. Signals influence routing only.
 */
export async function shouldRouteToReview(db: Db, organisationId: string, subjectId: string): Promise<boolean> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM risk_signals
     WHERE organisation_id = $1 AND subject_id = $2 AND severity = 'high'
       AND created_at > now() - interval '1 hour'`,
    [organisationId, subjectId],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

/* ------------------- velocity + duplicates ------------------- */

const VELOCITY_LIMIT = 10;        // verification attempts per subject
const VELOCITY_WINDOW_MS = 10 * 60_000;

export async function checkVelocity(
  db: Db, store: RateLimitStore, organisationId: string, subjectId: string,
): Promise<{ anomalous: boolean }> {
  const hits = await store.hit(`velocity:${organisationId}:${subjectId}`, VELOCITY_WINDOW_MS);
  if (hits > VELOCITY_LIMIT) {
    await recordRiskSignal(db, organisationId, {
      subjectId, kind: "velocity_anomaly", severity: "high",
      detail: { window: "10m", hits },
    });
    return { anomalous: true };
  }
  return { anomalous: false };
}

/**
 * Duplicate-capture detection: the exact same capture bytes reused across
 * different subjects inside a window is a strong replay/farming indicator.
 * Only a truncated hash is stored — never the capture itself.
 */
export async function checkDuplicateCapture(
  db: Db, organisationId: string, subjectId: string, imageBytes: Uint8Array,
): Promise<{ duplicate: boolean }> {
  const captureHash = sha256Hex(imageBytes).slice(0, 32);
  const { rows } = await db.query<{ subject_id: string | null }>(
    `SELECT DISTINCT subject_id FROM risk_signals
     WHERE organisation_id = $1 AND kind = 'capture_seen'
       AND detail->>'captureHash' = $2 AND created_at > now() - interval '24 hours'`,
    [organisationId, captureHash],
  );
  await recordRiskSignal(db, organisationId, {
    subjectId, kind: "capture_seen", severity: "info", detail: { captureHash },
  });
  const otherSubjects = rows.filter((r) => r.subject_id && r.subject_id !== subjectId);
  if (otherSubjects.length > 0) {
    await recordRiskSignal(db, organisationId, {
      subjectId, kind: "duplicate_capture", severity: "high",
      detail: { captureHash, otherSubjectCount: otherSubjects.length },
    });
    return { duplicate: true };
  }
  return { duplicate: false };
}
