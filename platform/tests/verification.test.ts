/**
 * Prompt 2 acceptance tests: capture sessions, consent-led enrolment,
 * 1:1 verification decisions, model gates, fail-closed behaviour, human
 * review, consent withdrawal, idempotency and signed webhooks.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

// Dev master key for envelope encryption (LocalKmsAdapter) — tests only.
process.env.BIOCHECK_MASTER_KEY_B64 = Buffer.alloc(32, 9).toString("base64url");
import { createPgliteDb, type Db } from "../src/server/db/client";
import { migrate } from "../src/server/db/migrate";
import { registerUser, verifyEmail } from "../src/server/auth/service";
import { createOrganisation, createWorkspace, createProject, inviteMember, acceptInvitation } from "../src/server/tenancy/service";
import { createApiKey, authenticateApiKey } from "../src/server/apikeys/service";
import {
  createCaptureSession, enrolSubject, verifySubject, getVerification, decideReviewCase,
  withdrawConsent, ensureDefaultPolicy, VerificationError,
} from "../src/server/verification/service";
import { decide, humanMessage } from "../src/server/verification/decision";
import {
  FakeProvider, FAKE_MODEL, FAKE_PAD_MODEL, VerifyCoreProvider, ProviderUnavailableError,
} from "../src/server/verification/providers";
import { withIdempotency, IdempotencyConflictError } from "../src/server/idempotency";
import {
  createWebhookEndpoint, enqueueWebhook, deliverDueWebhooks, verifyWebhookSignature,
} from "../src/server/webhooks/service";
import { verifyAuditChain } from "../src/server/audit/service";
import type { ApiKeyPrincipal } from "../src/server/apikeys/service";
import type { AuthContext } from "../src/server/authz/policy";

let db: Db;
let provider: FakeProvider;
let principal: ApiKeyPrincipal;
let ownerCtx: AuthContext;
let reviewerCtx: AuthContext;
let orgId: string;

const fixture = (person: string, overrides: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ person, ...overrides }));

const CONSENT = { noticeVersion: "notice-v1", purpose: "clinic check-in", lawfulBasis: "consent" };

async function approveFakeModels() {
  for (const [m, purpose] of [[FAKE_MODEL, "face_embedding"], [FAKE_PAD_MODEL, "passive_pad"]] as const) {
    await db.query(
      `INSERT INTO model_registry (id, model_id, sha256, purpose, commercial_use_approved, independent_report_ref, approved_by, expires_on)
       VALUES ($1,$2,$3,$4,TRUE,'TEST-REPORT-1','test-governance','2099-01-01')`,
      [randomUUID(), m.id, m.sha256, purpose],
    );
  }
}

async function newSession(purpose: "enrolment" | "verification") {
  return createCaptureSession(db, principal, purpose);
}

async function enrol(person = "alice", subjectRef = `subj-${person}`) {
  const session = await newSession("enrolment");
  return enrolSubject(db, principal, provider, {
    subjectRef, captureSessionToken: session.clientToken, imageBytes: fixture(person), consent: CONSENT,
  });
}

async function verify(person: string, subjectRef: string, overrides: Record<string, unknown> = {}) {
  const session = await newSession("verification");
  return verifySubject(db, principal, provider, {
    subjectRef, captureSessionToken: session.clientToken, imageBytes: fixture(person, overrides),
  });
}

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
  provider = new FakeProvider();
  await approveFakeModels();
  await ensureDefaultPolicy(db);

  const owner = await registerUser(db, "owner@p2.biocheck.local", "correct-horse-battery-staple");
  await verifyEmail(db, owner.emailVerificationToken);
  ownerCtx = { userId: owner.userId, platformRole: null };
  orgId = await createOrganisation(db, ownerCtx, "P2 Demo Org", "p2-demo");
  const ws = await createWorkspace(db, ownerCtx, orgId, "Main");
  const project = await createProject(db, ownerCtx, orgId, ws, "Verify");

  const key = await createApiKey(db, ownerCtx, orgId, project.projectId, project.environments.sandbox, "test",
    ["verification:create", "verification:read", "enrolment:create", "consent:manage"]);
  principal = await authenticateApiKey(db, key.secretKey, "verification:create");

  const reviewer = await registerUser(db, "reviewer@p2.biocheck.local", "correct-horse-battery-staple");
  await verifyEmail(db, reviewer.emailVerificationToken);
  const invite = await inviteMember(db, ownerCtx, orgId, "reviewer@p2.biocheck.local", "reviewer");
  await acceptInvitation(db, reviewer.userId, "reviewer@p2.biocheck.local", invite.token);
  reviewerCtx = { userId: reviewer.userId, platformRole: null };
});

afterAll(async () => {
  await db.close();
});

describe("decision policy (pure)", () => {
  const policy = {
    id: "p", version: 1, min_quality: 0.72, max_pose_degrees: 25, max_occlusion: 0.2,
    min_liveness: 0.93, approve_similarity: 0.74, review_similarity: 0.62,
  };
  it("covers every branch with machine-readable codes and human-safe messages", () => {
    expect(decide(policy, { faceDetected: false, quality: 1, pose: 0, occlusion: 0, isLive: true, liveness: 1, similarity: 1 }))
      .toEqual({ decision: "rejected", reasonCode: "FACE_NOT_DETECTED" });
    expect(decide(policy, { faceDetected: true, quality: 0.5, pose: 0, occlusion: 0, isLive: true, liveness: 1, similarity: 1 }).decision)
      .toBe("review");
    expect(decide(policy, { faceDetected: true, quality: 0.9, pose: 0, occlusion: 0, isLive: false, liveness: 0.99, similarity: 1 }))
      .toEqual({ decision: "rejected", reasonCode: "LIVENESS_FAILED" });
    expect(decide(policy, { faceDetected: true, quality: 0.9, pose: 0, occlusion: 0, isLive: true, liveness: 0.99, similarity: 0.8 }).decision)
      .toBe("approved");
    expect(decide(policy, { faceDetected: true, quality: 0.9, pose: 0, occlusion: 0, isLive: true, liveness: 0.99, similarity: 0.65 }).decision)
      .toBe("review");
    expect(decide(policy, { faceDetected: true, quality: 0.9, pose: 0, occlusion: 0, isLive: true, liveness: 0.99, similarity: 0.1 }).decision)
      .toBe("rejected");
    expect(humanMessage("LIVENESS_FAILED")).not.toMatch(/score|threshold|model/i);
  });
});

describe("capture sessions", () => {
  it("are one-use", async () => {
    const enrolment = await enrol("bob", "subj-bob");
    expect(enrolment.templateId).toBeTruthy();
    const session = await newSession("verification");
    await verifySubject(db, principal, provider, {
      subjectRef: "subj-bob", captureSessionToken: session.clientToken, imageBytes: fixture("bob"),
    });
    await expect(
      verifySubject(db, principal, provider, {
        subjectRef: "subj-bob", captureSessionToken: session.clientToken, imageBytes: fixture("bob"),
      }),
    ).rejects.toMatchObject({ code: "CAPTURE_SESSION_INVALID" });
  });

  it("bind purpose and reject forged tokens", async () => {
    const session = await newSession("enrolment");
    await expect(
      verifySubject(db, principal, provider, { subjectRef: "subj-bob", captureSessionToken: session.clientToken, imageBytes: fixture("bob") }),
    ).rejects.toMatchObject({ code: "CAPTURE_SESSION_PURPOSE_MISMATCH" });
    await expect(
      verifySubject(db, principal, provider, { subjectRef: "subj-bob", captureSessionToken: "bcs_forged.nonce.secret", imageBytes: fixture("bob") }),
    ).rejects.toMatchObject({ code: "CAPTURE_SESSION_INVALID" });
  });
});

describe("enrolment", () => {
  it("requires consent fields", async () => {
    const session = await newSession("enrolment");
    await expect(
      enrolSubject(db, principal, provider, {
        subjectRef: "subj-x", captureSessionToken: session.clientToken, imageBytes: fixture("x"),
        consent: { noticeVersion: "", purpose: "", lawfulBasis: "" },
      }),
    ).rejects.toMatchObject({ code: "CONSENT_INVALID" });
  });

  it("rejects numeric identity numbers as subject references", async () => {
    const session = await newSession("enrolment");
    await expect(
      enrolSubject(db, principal, provider, {
        subjectRef: "6301015009087", captureSessionToken: session.clientToken, imageBytes: fixture("x"), consent: CONSENT,
      }),
    ).rejects.toMatchObject({ code: "INVALID_SUBJECT_REF" });
  });

  it("refuses poor quality and non-live reference captures", async () => {
    const s1 = await newSession("enrolment");
    await expect(
      enrolSubject(db, principal, provider, {
        subjectRef: "subj-poor", captureSessionToken: s1.clientToken, imageBytes: fixture("poor", { quality: 0.3 }), consent: CONSENT,
      }),
    ).rejects.toMatchObject({ code: "CAPTURE_QUALITY_INSUFFICIENT" });
    const s2 = await newSession("enrolment");
    await expect(
      enrolSubject(db, principal, provider, {
        subjectRef: "subj-spoof", captureSessionToken: s2.clientToken, imageBytes: fixture("spoof", { live: false }), consent: CONSENT,
      }),
    ).rejects.toMatchObject({ code: "LIVENESS_FAILED" });
  });
});

describe("verification decisions", () => {
  it("approves the same person and stores policy/model versions", async () => {
    await enrol("carol", "subj-carol");
    const outcome = await verify("carol", "subj-carol");
    expect(outcome.decision).toBe("approved");
    expect(outcome.reasonCode).toBe("MATCH_CONFIRMED");
    const stored = await getVerification(db, principal, outcome.verificationId);
    expect(stored.policy_version).toBe(1);
    expect(await verifyAuditChain(db)).toBe(true);
  });

  it("rejects a different person", async () => {
    const outcome = await verify("mallory", "subj-carol");
    expect(outcome.decision).toBe("rejected");
    expect(outcome.reasonCode).toBe("MATCH_NOT_CONFIRMED");
  });

  it("rejects spoofs even when the face matches (fail closed)", async () => {
    const outcome = await verify("carol", "subj-carol", { live: false, attackType: "replay" });
    expect(outcome).toMatchObject({ decision: "rejected", reasonCode: "LIVENESS_FAILED" });
  });

  it("routes unknown subjects and missing references to rejection", async () => {
    const outcome = await verify("carol", "subj-never-enrolled");
    expect(outcome).toMatchObject({ decision: "rejected", reasonCode: "REFERENCE_NOT_FOUND" });
  });

  it("routes poor capture quality to human review with a case", async () => {
    const outcome = await verify("carol", "subj-carol", { quality: 0.4 });
    expect(outcome.decision).toBe("review");
    expect(outcome.reviewCaseId).toBeTruthy();
  });

  it("routes an unapproved model to review, never approval", async () => {
    await db.query(`UPDATE model_registry SET status = 'revoked' WHERE model_id = $1`, [FAKE_MODEL.id]);
    const outcome = await verify("carol", "subj-carol");
    expect(outcome).toMatchObject({ decision: "review", reasonCode: "MODEL_NOT_APPROVED" });
    await db.query(`UPDATE model_registry SET status = 'active' WHERE model_id = $1`, [FAKE_MODEL.id]);
  });

  it("fails closed to review when the provider is unavailable", async () => {
    const broken = new VerifyCoreProvider({
      endpoint: "http://localhost:9",
      apiKey: "x",
      timeoutMs: 200,
      transport: async () => { throw new Error("connection refused"); },
    });
    const session = await newSession("verification");
    const outcome = await verifySubject(db, principal, broken, {
      subjectRef: "subj-carol", captureSessionToken: session.clientToken, imageBytes: fixture("carol"),
    });
    expect(outcome).toMatchObject({ decision: "review", reasonCode: "SERVICE_UNAVAILABLE" });
  });
});

describe("human review", () => {
  it("requires a named reviewer with permission and a written reason", async () => {
    const outcome = await verify("carol", "subj-carol", { quality: 0.4 });
    expect(outcome.decision).toBe("review");
    await expect(decideReviewCase(db, reviewerCtx, orgId, outcome.verificationId, "approved", ""))
      .rejects.toMatchObject({ code: "REVIEW_REASON_REQUIRED" });
    const decided = await decideReviewCase(db, reviewerCtx, orgId, outcome.verificationId, "approved", "Manual comparison satisfied policy.");
    expect(decided.outcome).toBe("approved");
    // second decision on the same case is refused
    await expect(decideReviewCase(db, reviewerCtx, orgId, outcome.verificationId, "rejected", "changed my mind"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses reviewers without the reviews:decide permission", async () => {
    const outcome = await verify("carol", "subj-carol", { quality: 0.4 });
    const analyst = await registerUser(db, "analyst2@p2.biocheck.local", "correct-horse-battery-staple");
    await verifyEmail(db, analyst.emailVerificationToken);
    const invite = await inviteMember(db, ownerCtx, orgId, "analyst2@p2.biocheck.local", "analyst");
    await acceptInvitation(db, analyst.userId, "analyst2@p2.biocheck.local", invite.token);
    await expect(
      decideReviewCase(db, { userId: analyst.userId, platformRole: null }, orgId, outcome.verificationId, "approved", "should not work"),
    ).rejects.toThrow(/does not grant/);
  });
});

describe("consent withdrawal", () => {
  it("revokes templates, is idempotent and future verifications reject", async () => {
    const enrolment = await enrol("dave", "subj-dave");
    await withdrawConsent(db, principal, enrolment.consentId);
    await withdrawConsent(db, principal, enrolment.consentId); // idempotent
    const outcome = await verify("dave", "subj-dave");
    expect(outcome).toMatchObject({ decision: "rejected", reasonCode: "REFERENCE_NOT_FOUND" });
    const { rows } = await db.query(
      `SELECT status FROM reference_templates WHERE id = $1`, [enrolment.templateId],
    );
    expect(rows[0]).toMatchObject({ status: "revoked" });
  });
});

describe("idempotency", () => {
  it("replays identical requests and rejects body changes", async () => {
    let calls = 0;
    const handler = async () => ({ status: 201, body: { value: ++calls } });
    const a = await withIdempotency(db, principal.apiKeyId, "/v1/test", "idem-1", { x: 1 }, handler);
    const b = await withIdempotency(db, principal.apiKeyId, "/v1/test", "idem-1", { x: 1 }, handler);
    expect(a.body).toEqual({ value: 1 });
    expect(b.body).toEqual({ value: 1 });
    expect(b.replayed).toBe(true);
    expect(calls).toBe(1);
    await expect(withIdempotency(db, principal.apiKeyId, "/v1/test", "idem-1", { x: 2 }, handler))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

describe("webhooks", () => {
  it("signs deliveries, retries failures and dead-letters after max attempts", async () => {
    const endpoint = await createWebhookEndpoint(db, ownerCtx, orgId, principal.projectId, principal.environmentId,
      "https://client.example/webhooks", ["verification.completed", "consent.withdrawn"]);
    await enqueueWebhook(db, orgId, principal.environmentId, "verification.completed", { verificationId: "v-1", decision: "approved" });

    const received: { headers: Record<string, string>; body: string }[] = [];
    let fail = true;
    const transport = async (_url: string, headers: Record<string, string>, body: string) => {
      if (fail) throw new Error("down");
      received.push({ headers, body });
      return 200;
    };

    const first = await deliverDueWebhooks(db, transport);
    expect(first.failed).toBeGreaterThan(0);
    await db.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE status = 'failed'`);
    fail = false;
    const second = await deliverDueWebhooks(db, transport);
    expect(second.delivered).toBeGreaterThan(0);

    const { headers, body } = received[0];
    expect(verifyWebhookSignature(endpoint.signingSecret, headers["X-BioCheck-Timestamp"], body, headers["X-BioCheck-Signature"])).toBe(true);
    expect(verifyWebhookSignature("wrong-secret", headers["X-BioCheck-Timestamp"], body, headers["X-BioCheck-Signature"])).toBe(false);
    expect(verifyWebhookSignature(endpoint.signingSecret, "1000000000", body, headers["X-BioCheck-Signature"])).toBe(false); // stale
    expect(headers["X-BioCheck-Event-Id"]).toBeTruthy();

    // dead-letter path
    await enqueueWebhook(db, orgId, principal.environmentId, "verification.completed", { verificationId: "v-2" });
    fail = true;
    for (let i = 0; i < 6; i++) {
      await db.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE status IN ('pending','failed')`);
      await deliverDueWebhooks(db, transport);
    }
    const dead = await db.query(`SELECT 1 FROM webhook_deliveries WHERE status = 'dead'`);
    expect(dead.rows.length).toBeGreaterThan(0);
  });

  it("refuses non-HTTPS endpoints and unknown events", async () => {
    await expect(createWebhookEndpoint(db, ownerCtx, orgId, principal.projectId, principal.environmentId,
      "http://insecure.example", ["verification.completed"])).rejects.toThrow(/HTTPS/);
    await expect(createWebhookEndpoint(db, ownerCtx, orgId, principal.projectId, principal.environmentId,
      "https://ok.example", ["nope" as never])).rejects.toThrow(/valid event/);
  });
});

describe("immutability guarantees", () => {
  it("verification policies cannot be mutated", async () => {
    await expect(db.query(`UPDATE verification_policies SET approve_similarity = 0.1`)).rejects.toThrow(/immutable/);
    await expect(db.query(`DELETE FROM verification_policies`)).rejects.toThrow(/immutable/);
  });

  it("no plaintext embedding-like data is stored in reference_templates", async () => {
    const { rows } = await db.query<{ template_ciphertext: string }>(`SELECT template_ciphertext FROM reference_templates LIMIT 5`);
    for (const row of rows) {
      expect(() => JSON.parse(row.template_ciphertext)).toThrow(); // opaque, not JSON
      expect(row.template_ciphertext).not.toMatch(/person|embedding/);
    }
  });
});
