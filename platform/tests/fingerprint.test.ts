/**
 * Fingerprint modality acceptance tests: modality-tagged capture sessions,
 * consent-led fingerprint enrolment, 1:1 verification decisions, the
 * PAD-required approval cap, model gates, fail-closed behaviour and
 * cross-modality isolation from the face pipeline.
 *
 * HONESTY: these run against the deterministic FakeProvider only — no real
 * fingerprint capture or matching exists yet (docs/FINGERPRINT_BUILD_STATUS.md).
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.BIOCHECK_MASTER_KEY_B64 = Buffer.alloc(32, 9).toString("base64url");
import { createPgliteDb, type Db } from "../src/server/db/client";
import { migrate } from "../src/server/db/migrate";
import { registerUser, verifyEmail } from "../src/server/auth/service";
import { createOrganisation, createWorkspace, createProject } from "../src/server/tenancy/service";
import { createApiKey, authenticateApiKey } from "../src/server/apikeys/service";
import {
  createCaptureSession, enrolSubject, enrolFingerprint, verifyFingerprint, verifySubject,
  VerificationError,
} from "../src/server/verification/service";
import { decideFingerprint } from "../src/server/verification/decision";
import {
  FakeProvider, FAKE_MODEL, FAKE_PAD_MODEL, FAKE_FP_MODEL, FAKE_FP_PAD_MODEL,
  FAKE_FP_MATCHER_MODEL, VerifyCoreProvider, ProviderUnavailableError,
} from "../src/server/verification/providers";
import type { ApiKeyPrincipal } from "../src/server/apikeys/service";

let db: Db;
let provider: FakeProvider;
let principal: ApiKeyPrincipal;
let orgId: string;

const fpFixture = (finger: string, overrides: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ finger, ...overrides }));
const faceFixture = (person: string, overrides: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ person, ...overrides }));

const CONSENT = { noticeVersion: "notice-v1", purpose: "clinic check-in", lawfulBasis: "consent" };

const FP_POLICY = {
  id: "p", version: 1, min_quality: 0.6, min_minutiae: 16,
  approve_score: 0.8, review_score: 0.55, require_pad_for_approval: true,
};

async function approveModels() {
  const entries = [
    [FAKE_MODEL, "face_embedding"], [FAKE_PAD_MODEL, "passive_pad"],
    [FAKE_FP_MODEL, "fingerprint_extraction"], [FAKE_FP_PAD_MODEL, "fingerprint_pad"],
    [FAKE_FP_MATCHER_MODEL, "fingerprint_matching"],
  ] as const;
  for (const [m, purpose] of entries) {
    await db.query(
      `INSERT INTO model_registry (id, model_id, sha256, purpose, commercial_use_approved, independent_report_ref, approved_by, expires_on)
       VALUES ($1,$2,$3,$4,TRUE,'TEST-REPORT-1','test-governance','2099-01-01')`,
      [randomUUID(), m.id, m.sha256, purpose],
    );
  }
}

async function session(purpose: "enrolment" | "verification", modality: "face" | "fingerprint" = "fingerprint") {
  return createCaptureSession(db, principal, purpose, undefined, modality);
}

async function enrolFinger(subjectRef: string, finger = "alice-r-index") {
  const s = await session("enrolment");
  return enrolFingerprint(db, principal, provider, {
    subjectRef, captureSessionToken: s.clientToken, imageBytes: fpFixture(finger), consent: CONSENT,
  });
}

async function verifyFinger(subjectRef: string, finger = "alice-r-index", overrides: Record<string, unknown> = {}) {
  const s = await session("verification");
  return verifyFingerprint(db, principal, provider, {
    subjectRef, captureSessionToken: s.clientToken, imageBytes: fpFixture(finger, overrides),
  });
}

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
  provider = new FakeProvider();
  await approveModels();

  const owner = await registerUser(db, "owner-fp@biocheck.local", "correct-horse-battery-staple");
  await verifyEmail(db, owner.emailVerificationToken);
  const ownerCtx = { userId: owner.userId, platformRole: null };
  orgId = await createOrganisation(db, ownerCtx, "FP Test Org", "fp-test");
  const ws = await createWorkspace(db, ownerCtx, orgId, "Main");
  const project = await createProject(db, ownerCtx, orgId, ws, "Clinic");
  const key = await createApiKey(db, ownerCtx, orgId, project.projectId, project.environments.sandbox, "test",
    ["enrolment:create", "verification:create", "verification:read", "consent:manage"]);
  principal = await authenticateApiKey(db, key.secretKey, "verification:create");
});

afterAll(async () => {
  await db.close();
});

describe("fingerprint decision policy", () => {
  const base = {
    fingerDetected: true, quality: 0.85, minutiaeCount: 34,
    padPresent: true, padIsLive: true, score: 0.95,
  };

  it("approves a strong match with live PAD", () => {
    expect(decideFingerprint(FP_POLICY, base)).toEqual({ decision: "approved", reasonCode: "MATCH_CONFIRMED" });
  });

  it("caps approval at review when PAD was not performed", () => {
    expect(decideFingerprint(FP_POLICY, { ...base, padPresent: false, padIsLive: false }))
      .toEqual({ decision: "review", reasonCode: "PAD_UNAVAILABLE_REVIEW_REQUIRED" });
  });

  it("rejects when PAD says the finger is not live", () => {
    expect(decideFingerprint(FP_POLICY, { ...base, padIsLive: false }).reasonCode).toBe("PAD_FAILED");
  });

  it("routes poor quality and low minutiae to review", () => {
    expect(decideFingerprint(FP_POLICY, { ...base, quality: 0.2 }).decision).toBe("review");
    expect(decideFingerprint(FP_POLICY, { ...base, minutiaeCount: 4 }).decision).toBe("review");
  });

  it("rejects a clear non-match", () => {
    expect(decideFingerprint(FP_POLICY, { ...base, score: 0.1 }).reasonCode).toBe("MATCH_NOT_CONFIRMED");
  });
});

describe("fingerprint enrolment and verification", () => {
  it("enrols and verifies the same finger (approved with PAD)", async () => {
    await enrolFinger("member-001");
    const outcome = await verifyFinger("member-001");
    expect(outcome.decision).toBe("approved");
    expect(outcome.reasonCode).toBe("MATCH_CONFIRMED");
  });

  it("rejects a different finger", async () => {
    await enrolFinger("member-002", "bob-r-thumb");
    const outcome = await verifyFinger("member-002", "mallory-r-thumb");
    expect(outcome.decision).toBe("rejected");
    expect(outcome.reasonCode).toBe("MATCH_NOT_CONFIRMED");
  });

  it("caps a matching capture without PAD at human review", async () => {
    await enrolFinger("member-003", "carol-l-index");
    const outcome = await verifyFinger("member-003", "carol-l-index", { pad: false });
    expect(outcome.decision).toBe("review");
    expect(outcome.reasonCode).toBe("PAD_UNAVAILABLE_REVIEW_REQUIRED");
    expect(outcome.reviewCaseId).toBeTruthy();
  });

  it("rejects verification when no fingerprint enrolment exists", async () => {
    const outcome = await verifyFinger("member-never-enrolled");
    expect(outcome.decision).toBe("rejected");
    expect(outcome.reasonCode).toBe("REFERENCE_NOT_FOUND");
  });

  it("records modality on attempts and templates", async () => {
    await enrolFinger("member-004", "dave-r-index");
    await verifyFinger("member-004", "dave-r-index");
    const tpl = await db.query<{ modality: string }>(
      `SELECT modality FROM reference_templates rt JOIN subjects s ON s.id = rt.subject_id
       WHERE s.subject_ref = 'member-004'`);
    expect(tpl.rows[0].modality).toBe("fingerprint");
    const att = await db.query<{ modality: string }>(
      `SELECT va.modality FROM verification_attempts va JOIN subjects s ON s.id = va.subject_id
       WHERE s.subject_ref = 'member-004'`);
    expect(att.rows[0].modality).toBe("fingerprint");
  });

  it("refuses enrolment with a failed PAD", async () => {
    const s = await session("enrolment");
    await expect(enrolFingerprint(db, principal, provider, {
      subjectRef: "member-005", captureSessionToken: s.clientToken,
      imageBytes: fpFixture("eve-r-index", { padLive: false }), consent: CONSENT,
    })).rejects.toMatchObject({ code: "PAD_FAILED" });
  });

  it("refuses low-quality enrolment", async () => {
    const s = await session("enrolment");
    await expect(enrolFingerprint(db, principal, provider, {
      subjectRef: "member-006", captureSessionToken: s.clientToken,
      imageBytes: fpFixture("frank-r-index", { quality: 0.1 }), consent: CONSENT,
    })).rejects.toMatchObject({ code: "CAPTURE_QUALITY_INSUFFICIENT" });
  });
});

describe("cross-modality isolation", () => {
  it("a face capture session cannot be spent on fingerprint verification", async () => {
    const s = await session("verification", "face");
    await expect(verifyFingerprint(db, principal, provider, {
      subjectRef: "member-001", captureSessionToken: s.clientToken, imageBytes: fpFixture("alice-r-index"),
    })).rejects.toMatchObject({ code: "CAPTURE_SESSION_MODALITY_MISMATCH" });
  });

  it("a fingerprint capture session cannot be spent on face verification", async () => {
    const s = await session("verification", "fingerprint");
    await expect(verifySubject(db, principal, provider, {
      subjectRef: "member-001", captureSessionToken: s.clientToken, imageBytes: faceFixture("alice"),
    })).rejects.toMatchObject({ code: "CAPTURE_SESSION_MODALITY_MISMATCH" });
  });

  it("a face enrolment is never used as a fingerprint reference", async () => {
    // Face-enrol a subject, then attempt fingerprint verification: the
    // fingerprint path must see no reference, not silently reuse the face one.
    const faceSession = await session("enrolment", "face");
    await enrolSubject(db, principal, provider, {
      subjectRef: "member-face-only", captureSessionToken: faceSession.clientToken,
      imageBytes: faceFixture("grace"), consent: CONSENT,
    });
    const outcome = await verifyFinger("member-face-only", "grace");
    expect(outcome.reasonCode).toBe("REFERENCE_NOT_FOUND");
  });
});

describe("model governance", () => {
  it("routes to review when the matcher model is revoked", async () => {
    await enrolFinger("member-007", "heidi-r-index");
    await db.query(`UPDATE model_registry SET status = 'revoked' WHERE model_id = $1`, [FAKE_FP_MATCHER_MODEL.id]);
    const outcome = await verifyFinger("member-007", "heidi-r-index");
    await db.query(`UPDATE model_registry SET status = 'active' WHERE model_id = $1`, [FAKE_FP_MATCHER_MODEL.id]);
    expect(outcome.decision).toBe("review");
    expect(outcome.reasonCode).toBe("MODEL_NOT_APPROVED");
  });
});

describe("fail-closed provider behaviour", () => {
  it("routes to review when verify-core fingerprint endpoints are unavailable (503)", async () => {
    const unavailable = new VerifyCoreProvider({
      endpoint: "http://localhost:9",
      apiKey: "k",
      transport: async () => new Response(JSON.stringify({ error: "Fingerprint verification is not configured; failing closed." }), { status: 503 }),
    });
    await enrolFinger("member-008", "ivan-r-index");
    const s = await session("verification");
    const outcome = await verifyFingerprint(db, principal, unavailable, {
      subjectRef: "member-008", captureSessionToken: s.clientToken, imageBytes: fpFixture("ivan-r-index"),
    });
    expect(outcome.decision).toBe("review");
    expect(outcome.reasonCode).toBe("SERVICE_UNAVAILABLE");
  });

  it("VerifyCoreProvider surfaces fingerprint 503 as ProviderUnavailableError", async () => {
    const unavailable = new VerifyCoreProvider({
      endpoint: "http://localhost:9",
      apiKey: "k",
      transport: async () => new Response("{}", { status: 503 }),
    });
    await expect(unavailable.analyseFingerprint(Buffer.from("x"), "nonce"))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("no raw biometric leakage (fingerprint tables)", () => {
  it("stores only opaque ciphertext for fingerprint templates", async () => {
    const { rows } = await db.query<{ template_ciphertext: string }>(
      `SELECT template_ciphertext FROM reference_templates WHERE modality = 'fingerprint' LIMIT 5`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // The fake fixture plaintext must never appear in what the platform stores.
      expect(row.template_ciphertext).not.toContain("alice");
      expect(row.template_ciphertext).not.toContain("finger");
      expect(row.template_ciphertext).not.toContain("fp:");
    }
  });
});
