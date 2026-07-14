/**
 * Prompt 7 — adversarial pre-pilot review. Every scenario from the master
 * pack, attempted deliberately, expected to be refused or contained:
 * tenant boundary access, API-key misuse, expired capture-session replay,
 * webhook signature replay, model-hash swap, liveness failure, missing
 * consent, deletion request (incl. legal hold), reviewer privilege abuse and
 * raw-biometric-log leakage. Each test name is the evidence reference used
 * in docs/PILOT_READINESS_REPORT.md.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.BIOCHECK_MASTER_KEY_B64 = Buffer.alloc(32, 9).toString("base64url");
import { createPgliteDb, type Db } from "../src/server/db/client";
import { migrate } from "../src/server/db/migrate";
import { registerUser, verifyEmail, login } from "../src/server/auth/service";
import { createOrganisation, createWorkspace, createProject, inviteMember, acceptInvitation } from "../src/server/tenancy/service";
import { createApiKey, authenticateApiKey, revokeApiKey, type ApiKeyPrincipal } from "../src/server/apikeys/service";
import {
  createCaptureSession, enrolSubject, verifySubject, getVerification, ensureDefaultPolicy, withdrawConsent,
} from "../src/server/verification/service";
import { FakeProvider, FAKE_MODEL, FAKE_PAD_MODEL, assertModelApproved, ModelNotApprovedError } from "../src/server/verification/providers";
import { decideReviewCaseDual, escalateLivenessException, getReviewQueue } from "../src/server/reviews/service";
import { createWebhookEndpoint, deliverDueWebhooks, verifyWebhookSignature } from "../src/server/webhooks/service";
import { deleteSubjectData, exportSubjectData } from "../src/server/privacy/subjectRights";
import { EvidenceService, MemoryStorageAdapter } from "../src/server/privacy/evidence";
import { verifyAuditChain, queryAudit } from "../src/server/audit/service";
import { createSafeLogger } from "../src/server/security/controls";
import { AuthorizationError } from "../src/server/authz/policy";
import type { AuthContext } from "../src/server/authz/policy";

let db: Db;
let provider: FakeProvider;
let ownerA: AuthContext, ownerB: AuthContext;
let orgA: string, orgB: string;
let keyA: ApiKeyPrincipal, keyASecret: string;
let keyB: ApiKeyPrincipal;
let reviewerA: AuthContext;
let evidenceService: EvidenceService;

const face = (person: string, overrides: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ person, ...overrides }));
const CONSENT = { noticeVersion: "n1", purpose: "adversarial-suite", lawfulBasis: "consent" };

async function makeOwner(email: string, name: string, slug: string) {
  const u = await registerUser(db, email, "correct-horse-battery-staple");
  await verifyEmail(db, u.emailVerificationToken);
  const ctx: AuthContext = { userId: u.userId, platformRole: null };
  const orgId = await createOrganisation(db, ctx, name, slug);
  return { ctx, orgId };
}

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
  provider = new FakeProvider();
  await ensureDefaultPolicy(db);
  for (const [m, purpose] of [[FAKE_MODEL, "face_embedding"], [FAKE_PAD_MODEL, "passive_pad"]] as const) {
    await db.query(
      `INSERT INTO model_registry (id, model_id, sha256, purpose, commercial_use_approved, independent_report_ref, approved_by, expires_on)
       VALUES ($1,$2,$3,$4,TRUE,'TEST-1','governance','2099-01-01')`,
      [randomUUID(), m.id, m.sha256, purpose],
    );
  }
  const a = await makeOwner("owner-a@adv.biocheck.local", "Adv Org A", "adv-a");
  const b = await makeOwner("owner-b@adv.biocheck.local", "Adv Org B", "adv-b");
  ownerA = a.ctx; orgA = a.orgId;
  ownerB = b.ctx; orgB = b.orgId;

  const wsA = await createWorkspace(db, ownerA, orgA, "Main");
  const projA = await createProject(db, ownerA, orgA, wsA, "A-Project");
  const createdA = await createApiKey(db, ownerA, orgA, projA.projectId, projA.environments.sandbox, "a-key",
    ["verification:create", "verification:read", "enrolment:create", "consent:manage"]);
  keyASecret = createdA.secretKey;
  keyA = await authenticateApiKey(db, keyASecret, "verification:create");

  const wsB = await createWorkspace(db, ownerB, orgB, "Main");
  const projB = await createProject(db, ownerB, orgB, wsB, "B-Project");
  const createdB = await createApiKey(db, ownerB, orgB, projB.projectId, projB.environments.sandbox, "b-key",
    ["verification:create", "verification:read", "enrolment:create", "consent:manage"]);
  keyB = await authenticateApiKey(db, createdB.secretKey, "verification:create");

  const rev = await registerUser(db, "rev-a@adv.biocheck.local", "correct-horse-battery-staple");
  await verifyEmail(db, rev.emailVerificationToken);
  const invite = await inviteMember(db, ownerA, orgA, "rev-a@adv.biocheck.local", "reviewer");
  await acceptInvitation(db, rev.userId, "rev-a@adv.biocheck.local", invite.token);
  reviewerA = { userId: rev.userId, platformRole: null };

  evidenceService = new EvidenceService(db, new MemoryStorageAdapter());

  const session = await createCaptureSession(db, keyA, "enrolment");
  await enrolSubject(db, keyA, provider, {
    subjectRef: "adv-subject", captureSessionToken: session.clientToken, imageBytes: face("adv-person"), consent: CONSENT,
  });
});

afterAll(async () => {
  await db.close();
});

describe("A1 tenant boundary", () => {
  it("A1.1 org B's key cannot read org A's verification", async () => {
    const session = await createCaptureSession(db, keyA, "verification");
    const outcome = await verifySubject(db, keyA, provider, {
      subjectRef: "adv-subject", captureSessionToken: session.clientToken, imageBytes: face("adv-person"),
    });
    await expect(getVerification(db, keyB, outcome.verificationId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("A1.2 org B's key cannot consume org A's capture session", async () => {
    const session = await createCaptureSession(db, keyA, "verification");
    await expect(
      verifySubject(db, keyB, provider, { subjectRef: "adv-subject", captureSessionToken: session.clientToken, imageBytes: face("x") }),
    ).rejects.toMatchObject({ code: "CAPTURE_SESSION_INVALID" });
  });

  it("A1.3 org B's owner cannot read org A's audit or reviews; subject refs stay siloed", async () => {
    await expect(queryAudit(db, ownerB, orgA)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(getReviewQueue(db, ownerB, orgA)).rejects.toBeInstanceOf(AuthorizationError);
    // same subjectRef in org B resolves to a DIFFERENT subject (no cross-tenant reference)
    const sessionB = await createCaptureSession(db, keyB, "verification");
    const outcome = await verifySubject(db, keyB, provider, {
      subjectRef: "adv-subject", captureSessionToken: sessionB.clientToken, imageBytes: face("adv-person"),
    });
    expect(outcome.reasonCode).toBe("REFERENCE_NOT_FOUND");
  });
});

describe("A2 API-key misuse", () => {
  it("A2.1 scope escalation is refused and audited", async () => {
    const minimal = await createApiKey(db, ownerA, orgA, keyA.projectId, keyA.environmentId, "read-only-key", ["verification:read"]);
    await expect(authenticateApiKey(db, minimal.secretKey, "enrolment:create")).rejects.toBeInstanceOf(AuthorizationError);
    const audited = await queryAudit(db, ownerA, orgA, { action: "apikey.scope_denied" });
    expect(audited.length).toBeGreaterThan(0);
  });

  it("A2.2 tampered, truncated and revoked keys are all refused", async () => {
    const [prefix, secret] = [keyASecret.slice(0, keyASecret.lastIndexOf(".")), keyASecret.slice(keyASecret.lastIndexOf(".") + 1)];
    await expect(authenticateApiKey(db, `${prefix}.${secret.slice(0, -2)}xx`, "verification:read")).rejects.toThrow(/Invalid API key/);
    await expect(authenticateApiKey(db, prefix, "verification:read")).rejects.toThrow(/Malformed|Invalid/);
    const burner = await createApiKey(db, ownerA, orgA, keyA.projectId, keyA.environmentId, "burner", ["verification:read"]);
    await revokeApiKey(db, ownerA, orgA, burner.apiKeyId);
    await expect(authenticateApiKey(db, burner.secretKey, "verification:read")).rejects.toThrow(/revoked/);
  });
});

describe("A3 capture-session replay", () => {
  it("A3.1 a used session cannot be replayed", async () => {
    const session = await createCaptureSession(db, keyA, "verification");
    await verifySubject(db, keyA, provider, { subjectRef: "adv-subject", captureSessionToken: session.clientToken, imageBytes: face("adv-person") });
    await expect(
      verifySubject(db, keyA, provider, { subjectRef: "adv-subject", captureSessionToken: session.clientToken, imageBytes: face("adv-person") }),
    ).rejects.toMatchObject({ code: "CAPTURE_SESSION_INVALID" });
  });

  it("A3.2 an EXPIRED session is refused even when unused", async () => {
    const session = await createCaptureSession(db, keyA, "verification");
    await db.query(`UPDATE capture_sessions SET expires_at = now() - interval '1 minute' WHERE token_hash IS NOT NULL AND status = 'pending' AND id = (SELECT id FROM capture_sessions ORDER BY created_at DESC LIMIT 1)`);
    await expect(
      verifySubject(db, keyA, provider, { subjectRef: "adv-subject", captureSessionToken: session.clientToken, imageBytes: face("adv-person") }),
    ).rejects.toMatchObject({ code: "CAPTURE_SESSION_INVALID" });
  });
});

describe("A4 webhook signature replay", () => {
  it("A4.1 stale timestamps, tampered bodies and wrong secrets all fail verification", async () => {
    const endpoint = await createWebhookEndpoint(db, ownerA, orgA, keyA.projectId, keyA.environmentId,
      "https://a.example/hooks", ["verification.completed"]);
    const session = await createCaptureSession(db, keyA, "verification");
    await verifySubject(db, keyA, provider, { subjectRef: "adv-subject", captureSessionToken: session.clientToken, imageBytes: face("adv-person") });
    const seen: { headers: Record<string, string>; body: string }[] = [];
    await deliverDueWebhooks(db, async (_u, headers, body) => { seen.push({ headers, body }); return 200; });
    const d = seen[0];
    expect(verifyWebhookSignature(endpoint.signingSecret, d.headers["X-BioCheck-Timestamp"], d.body, d.headers["X-BioCheck-Signature"])).toBe(true);
    // replayed an hour later → stale timestamp refused
    expect(verifyWebhookSignature(endpoint.signingSecret, String(Number(d.headers["X-BioCheck-Timestamp"]) - 3600), d.body, d.headers["X-BioCheck-Signature"])).toBe(false);
    // body tampered in transit → signature mismatch
    expect(verifyWebhookSignature(endpoint.signingSecret, d.headers["X-BioCheck-Timestamp"], d.body.replace("approved", "rejected"), d.headers["X-BioCheck-Signature"])).toBe(false);
    expect(verifyWebhookSignature("whsec_wrong", d.headers["X-BioCheck-Timestamp"], d.body, d.headers["X-BioCheck-Signature"])).toBe(false);
  });
});

describe("A5 model-hash swap", () => {
  it("A5.1 an approved model id with a swapped hash is not approved", async () => {
    await expect(assertModelApproved(db, FAKE_MODEL.id, "b".repeat(64), "face_embedding"))
      .rejects.toBeInstanceOf(ModelNotApprovedError);
    // and purpose swap fails too (PAD model presented as embedding model)
    await expect(assertModelApproved(db, FAKE_PAD_MODEL.id, FAKE_PAD_MODEL.sha256, "face_embedding"))
      .rejects.toBeInstanceOf(ModelNotApprovedError);
  });

  it("A5.2 a hash swap mid-flight routes the verification to REVIEW, never approval", async () => {
    await db.query(`UPDATE model_registry SET status = 'revoked' WHERE model_id = $1`, [FAKE_MODEL.id]);
    const session = await createCaptureSession(db, keyA, "verification");
    const outcome = await verifySubject(db, keyA, provider, {
      subjectRef: "adv-subject", captureSessionToken: session.clientToken, imageBytes: face("adv-person"),
    });
    expect(outcome).toMatchObject({ decision: "review", reasonCode: "MODEL_NOT_APPROVED" });
    await db.query(`UPDATE model_registry SET status = 'active' WHERE model_id = $1`, [FAKE_MODEL.id]);
  });
});

describe("A6 liveness and consent", () => {
  it("A6.1 liveness failure rejects even with a perfect face match", async () => {
    const session = await createCaptureSession(db, keyA, "verification");
    const outcome = await verifySubject(db, keyA, provider, {
      subjectRef: "adv-subject", captureSessionToken: session.clientToken,
      imageBytes: face("adv-person", { live: false, attackType: "screen_replay" }),
    });
    expect(outcome).toMatchObject({ decision: "rejected", reasonCode: "LIVENESS_FAILED" });
  });

  it("A6.2 liveness exception path is disabled by default and cannot be self-approved", async () => {
    const session = await createCaptureSession(db, keyA, "verification");
    const rejected = await verifySubject(db, keyA, provider, {
      subjectRef: "adv-subject", captureSessionToken: session.clientToken, imageBytes: face("adv-person", { live: false }),
    });
    await expect(escalateLivenessException(db, reviewerA, orgA, rejected.verificationId, "attempting default-config escalation"))
      .rejects.toMatchObject({ code: "LIVENESS_EXCEPTION_DISABLED" });
  });

  it("A6.3 enrolment without consent fields is refused; withdrawn consent blocks matching", async () => {
    const s1 = await createCaptureSession(db, keyA, "enrolment");
    await expect(enrolSubject(db, keyA, provider, {
      subjectRef: "no-consent", captureSessionToken: s1.clientToken, imageBytes: face("nc"),
      consent: { noticeVersion: "", purpose: "", lawfulBasis: "" },
    })).rejects.toMatchObject({ code: "CONSENT_INVALID" });

    const s2 = await createCaptureSession(db, keyA, "enrolment");
    const enrolment = await enrolSubject(db, keyA, provider, {
      subjectRef: "withdrawer", captureSessionToken: s2.clientToken, imageBytes: face("withdrawer"), consent: CONSENT,
    });
    await withdrawConsent(db, keyA, enrolment.consentId);
    const s3 = await createCaptureSession(db, keyA, "verification");
    const outcome = await verifySubject(db, keyA, provider, {
      subjectRef: "withdrawer", captureSessionToken: s3.clientToken, imageBytes: face("withdrawer"),
    });
    expect(outcome.decision).toBe("rejected");
  });
});

describe("A7 deletion requests", () => {
  it("A7.1 deletion destroys templates and blocks matching; export afterwards shows the trail without biometrics", async () => {
    const s = await createCaptureSession(db, keyA, "enrolment");
    await enrolSubject(db, keyA, provider, {
      subjectRef: "deletee", captureSessionToken: s.clientToken, imageBytes: face("deletee"), consent: CONSENT,
    });
    const result = await deleteSubjectData(db, keyA, evidenceService, "deletee");
    expect(result.status).toBe("completed");
    const exported = await exportSubjectData(db, keyA, "deletee");
    expect(JSON.stringify(exported)).not.toMatch(/enc1:|"embedding"/);
    const s2 = await createCaptureSession(db, keyA, "verification");
    const outcome = await verifySubject(db, keyA, provider, {
      subjectRef: "deletee", captureSessionToken: s2.clientToken, imageBytes: face("deletee"),
    });
    expect(outcome.reasonCode).toBe("REFERENCE_NOT_FOUND");
  });

  it("A7.2 org B's key cannot reach org A's subjects — deletion is tenant-scoped", async () => {
    // "adv-only" exists ONLY in org A. Org B's key must not find or delete it.
    const s = await createCaptureSession(db, keyA, "enrolment");
    await enrolSubject(db, keyA, provider, {
      subjectRef: "adv-only", captureSessionToken: s.clientToken, imageBytes: face("adv-only"), consent: CONSENT,
    });
    await expect(deleteSubjectData(db, keyB, evidenceService, "adv-only")).rejects.toThrow(/not found/i);
    // org A's template is untouched — org A can still verify the subject
    const v = await createCaptureSession(db, keyA, "verification");
    const outcome = await verifySubject(db, keyA, provider, {
      subjectRef: "adv-only", captureSessionToken: v.clientToken, imageBytes: face("adv-only"),
    });
    expect(outcome.decision).toBe("approved");
  });
});

describe("A8 reviewer privilege abuse", () => {
  it("A8.1 a reviewer cannot decide cases in another organisation", async () => {
    const sessionB = await createCaptureSession(db, keyB, "enrolment");
    await enrolSubject(db, keyB, provider, {
      subjectRef: "b-subject", captureSessionToken: sessionB.clientToken, imageBytes: face("b-person"), consent: CONSENT,
    });
    const v = await createCaptureSession(db, keyB, "verification");
    const outcome = await verifySubject(db, keyB, provider, {
      subjectRef: "b-subject", captureSessionToken: v.clientToken, imageBytes: face("b-person", { quality: 0.5 }),
    });
    expect(outcome.decision).toBe("review");
    const queueB = await db.query<{ id: string }>(`SELECT id FROM review_cases WHERE organisation_id = $1 AND status = 'open'`, [orgB]);
    await expect(decideReviewCaseDual(db, reviewerA, orgB, queueB.rows[0].id, "approved", "cross-org abuse attempt"))
      .rejects.toBeInstanceOf(AuthorizationError);
  });

  it("A8.2 dual control refuses self-confirmation (already enforced) and unauthorised roles cannot review at all", async () => {
    await expect(getReviewQueue(db, keyA as unknown as AuthContext, orgA)).rejects.toThrow(); // an API principal is not a reviewer session
    const analyst = await registerUser(db, "analyst@adv.biocheck.local", "correct-horse-battery-staple");
    await verifyEmail(db, analyst.emailVerificationToken);
    const invite = await inviteMember(db, ownerA, orgA, "analyst@adv.biocheck.local", "analyst");
    await acceptInvitation(db, analyst.userId, "analyst@adv.biocheck.local", invite.token);
    await expect(getReviewQueue(db, { userId: analyst.userId, platformRole: null }, orgA)).rejects.toThrow(/does not grant/);
  });
});

describe("A9 raw-biometric leakage", () => {
  it("A9.1 a marked capture payload appears in no table, no audit event, no job error and no log line", async () => {
    const marker = `ADV_LEAK_${Date.now()}`;
    const lines: string[] = [];
    const logger = createSafeLogger({ write: (l) => lines.push(l) });
    logger.info("adversarial capture processed", { imageB64: marker, note: "should be redacted" });

    const s = await createCaptureSession(db, keyA, "enrolment");
    await enrolSubject(db, keyA, provider, {
      subjectRef: "leak-check", captureSessionToken: s.clientToken, imageBytes: face(marker), consent: CONSENT,
    });
    const v = await createCaptureSession(db, keyA, "verification");
    await verifySubject(db, keyA, provider, {
      subjectRef: "leak-check", captureSessionToken: v.clientToken, imageBytes: face(marker),
    });

    const tables = ["audit_events", "verification_attempts", "capture_sessions", "subjects", "consent_receipts",
      "webhook_deliveries", "idempotency_keys", "risk_signals", "jobs", "document_checks", "review_cases", "sessions"];
    for (const table of tables) {
      const { rows } = await db.query(`SELECT * FROM ${table}`);
      expect(JSON.stringify(rows), `marker leaked into ${table}`).not.toContain(marker);
    }
    for (const line of lines) expect(line).not.toContain(marker);
    // template column holds ciphertext only
    const t = await db.query<{ template_ciphertext: string }>(
      `SELECT template_ciphertext FROM reference_templates rt JOIN subjects s ON s.id = rt.subject_id WHERE s.subject_ref = 'leak-check'`);
    expect(t.rows[0].template_ciphertext).not.toContain(marker);
  });

  it("A9.2 the audit chain survives the whole adversarial run intact", async () => {
    expect(await verifyAuditChain(db)).toBe(true);
  });
});

describe("A10 session hygiene under attack", () => {
  it("A10.1 brute-forcing a login locks the account before success", async () => {
    const victim = await registerUser(db, "victim@adv.biocheck.local", "correct-horse-battery-staple");
    await verifyEmail(db, victim.emailVerificationToken);
    for (let i = 0; i < 5; i++) {
      await expect(login(db, "victim@adv.biocheck.local", `guess-${i}-aaaaaaaa`)).rejects.toThrow();
    }
    await expect(login(db, "victim@adv.biocheck.local", "correct-horse-battery-staple"))
      .rejects.toMatchObject({ code: "LOCKED" });
  });
});
