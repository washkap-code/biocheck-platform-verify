/**
 * Prompt 4 acceptance tests: staged document checks with synthetic fixtures,
 * masked field storage, review-queue operations, dual control, liveness
 * exception policy, fraud signals and every escalation path.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.BIOCHECK_MASTER_KEY_B64 = Buffer.alloc(32, 9).toString("base64url");
import { createPgliteDb, type Db } from "../src/server/db/client";
import { migrate } from "../src/server/db/migrate";
import { registerUser, verifyEmail } from "../src/server/auth/service";
import { createOrganisation, createWorkspace, createProject, inviteMember, acceptInvitation } from "../src/server/tenancy/service";
import { createApiKey, authenticateApiKey, type ApiKeyPrincipal } from "../src/server/apikeys/service";
import { createCaptureSession, enrolSubject, verifySubject, ensureDefaultPolicy } from "../src/server/verification/service";
import { FakeProvider, FAKE_MODEL, FAKE_PAD_MODEL } from "../src/server/verification/providers";
import { SyntheticDocumentProvider, maskDocumentNumber } from "../src/server/documents/provider";
import { runDocumentCheck, listDocumentChecks } from "../src/server/documents/service";
import { getReviewQueue, decideReviewCaseDual, escalateLivenessException, getCaptureFeedbackSummary, RETRY_TIPS } from "../src/server/reviews/service";
import { NoopAttestationAdapter, recordAttestation, checkVelocity, checkDuplicateCapture, recordRiskSignal, shouldRouteToReview } from "../src/server/fraud/service";
import { EvidenceService, MemoryStorageAdapter } from "../src/server/privacy/evidence";
import { MemoryRateLimitStore } from "../src/server/security/controls";
import { verifyAuditChain } from "../src/server/audit/service";
import type { AuthContext } from "../src/server/authz/policy";

let db: Db;
let provider: FakeProvider;
let docProvider: SyntheticDocumentProvider;
let principal: ApiKeyPrincipal;
let ownerCtx: AuthContext;
let reviewer1: AuthContext;
let reviewer2: AuthContext;
let orgId: string;
let evidenceService: EvidenceService;

const face = (person: string, overrides: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ person, ...overrides }));
const doc = (fields: Record<string, unknown>) => Buffer.from(JSON.stringify(fields));
const CONSENT = { noticeVersion: "n1", purpose: "onboarding", lawfulBasis: "consent" };

async function makeReviewer(email: string): Promise<AuthContext> {
  const u = await registerUser(db, email, "correct-horse-battery-staple");
  await verifyEmail(db, u.emailVerificationToken);
  const invite = await inviteMember(db, ownerCtx, orgId, email, "reviewer");
  await acceptInvitation(db, u.userId, email, invite.token);
  return { userId: u.userId, platformRole: null };
}

async function verify(person: string, subjectRef: string, overrides: Record<string, unknown> = {}) {
  const session = await createCaptureSession(db, principal, "verification");
  return verifySubject(db, principal, provider, {
    subjectRef, captureSessionToken: session.clientToken, imageBytes: face(person, overrides),
  });
}

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
  provider = new FakeProvider();
  docProvider = new SyntheticDocumentProvider();
  await ensureDefaultPolicy(db);
  for (const [m, purpose] of [[FAKE_MODEL, "face_embedding"], [FAKE_PAD_MODEL, "passive_pad"]] as const) {
    await db.query(
      `INSERT INTO model_registry (id, model_id, sha256, purpose, commercial_use_approved, independent_report_ref, approved_by, expires_on)
       VALUES ($1,$2,$3,$4,TRUE,'TEST-1','governance','2099-01-01')`,
      [randomUUID(), m.id, m.sha256, purpose],
    );
  }
  const owner = await registerUser(db, "owner@p4.biocheck.local", "correct-horse-battery-staple");
  await verifyEmail(db, owner.emailVerificationToken);
  ownerCtx = { userId: owner.userId, platformRole: null };
  orgId = await createOrganisation(db, ownerCtx, "P4 Org", "p4-org");
  const ws = await createWorkspace(db, ownerCtx, orgId, "Main");
  const project = await createProject(db, ownerCtx, orgId, ws, "Onboarding");
  const key = await createApiKey(db, ownerCtx, orgId, project.projectId, project.environments.sandbox, "k",
    ["verification:create", "verification:read", "enrolment:create", "consent:manage"]);
  principal = await authenticateApiKey(db, key.secretKey, "verification:create");
  reviewer1 = await makeReviewer("rev1@p4.biocheck.local");
  reviewer2 = await makeReviewer("rev2@p4.biocheck.local");
  evidenceService = new EvidenceService(db, new MemoryStorageAdapter());

  const session = await createCaptureSession(db, principal, "enrolment");
  await enrolSubject(db, principal, provider, {
    subjectRef: "subj-p4", captureSessionToken: session.clientToken, imageBytes: face("p4person"), consent: CONSENT,
  });
});

afterAll(async () => {
  await db.close();
});

describe("document checks (synthetic fixtures only)", () => {
  it("passes a clean synthetic document and masks the number", async () => {
    const outcome = await runDocumentCheck(db, principal, docProvider, {
      imageBytes: doc({ docClass: "passport", country: "zw", number: "AB1234567", expiry: "2031-05-01", person: "p4person" }),
    });
    expect(outcome.overall).toBe("pass");
    expect(outcome.docNumberMasked).toBe("*****4567");
    expect(outcome.portraitCaptureRef).toBeTruthy();
    // full number appears nowhere in the database
    for (const table of ["document_checks", "audit_events", "risk_signals"]) {
      const { rows } = await db.query(`SELECT * FROM ${table}`);
      expect(JSON.stringify(rows), `full doc number leaked into ${table}`).not.toContain("AB1234567");
    }
  });

  it("fails expired documents and routes tamper signals to review", async () => {
    const expired = await runDocumentCheck(db, principal, docProvider, {
      imageBytes: doc({ docClass: "national_id", country: "ZW", number: "X99", expiry: "2020-01-01", person: "p" }),
    });
    expect(expired).toMatchObject({ overall: "fail", reasonCode: "DOC_EXPIRED" });

    const tampered = await runDocumentCheck(db, principal, docProvider, {
      imageBytes: doc({ docClass: "passport", country: "ZW", number: "T11", expiry: "2031-01-01", person: "p", tamper: ["font_inconsistent", "photo_edge_artifacts"] }),
    });
    expect(tampered).toMatchObject({ overall: "review", reasonCode: "DOC_TAMPER_SIGNALS" });
    expect(tampered.stages.tamper).toBe("fail");
  });

  it("handles unreadable input and unknown classes without crashing", async () => {
    const junk = await runDocumentCheck(db, principal, docProvider, { imageBytes: Buffer.from([1, 2, 3]) });
    expect(junk.overall).toBe("fail");
    const unknown = await runDocumentCheck(db, principal, docProvider, {
      imageBytes: doc({ docClass: "library_card", number: "L1", expiry: "2031-01-01", person: "p" }),
    });
    expect(unknown).toMatchObject({ overall: "review", reasonCode: "DOC_CLASS_UNKNOWN" });
  });

  it("retains encrypted evidence only under explicit tenant policy, and the console list is masked", async () => {
    const outcome = await runDocumentCheck(db, principal, docProvider, {
      imageBytes: doc({ docClass: "passport", country: "ZW", number: "EV5555", expiry: "2031-01-01", person: "p" }),
      evidence: { service: evidenceService, purpose: "onboarding dispute window", retentionExpiresAt: new Date(Date.now() + 60_000) },
    });
    const row = await db.query<{ evidence_id: string | null }>(
      `SELECT evidence_id FROM document_checks WHERE id = $1`, [outcome.documentCheckId]);
    expect(row.rows[0].evidence_id).toBeTruthy();
    const listed = await listDocumentChecks(db, orgId);
    expect(JSON.stringify(listed)).not.toContain("EV5555");
    expect(JSON.stringify(listed)).toContain("5555"); // masked tail only
  });

  it("maskDocumentNumber never returns the full value", () => {
    expect(maskDocumentNumber("AB1234567")).toBe("*****4567");
    expect(maskDocumentNumber("12")).toBe("**12");
    expect(maskDocumentNumber(null)).toBeNull();
  });
});

describe("review operations", () => {
  it("orders the queue by risk then SLA and supports filters", async () => {
    await verify("p4person", "subj-p4", { quality: 0.4 });               // standard review
    await db.query(`UPDATE model_registry SET status = 'revoked' WHERE model_id = $1`, [FAKE_MODEL.id]);
    await verify("p4person", "subj-p4");                                  // MODEL_NOT_APPROVED → high risk, dual control
    await db.query(`UPDATE model_registry SET status = 'active' WHERE model_id = $1`, [FAKE_MODEL.id]);

    const queue = await getReviewQueue(db, reviewer1, orgId, {});
    expect(queue.length).toBeGreaterThanOrEqual(2);
    expect((queue[0] as { risk_level: string }).risk_level).toBe("high");
    const highOnly = await getReviewQueue(db, reviewer1, orgId, { riskLevel: "high" });
    expect(highOnly.every((r) => (r as { risk_level: string }).risk_level === "high")).toBe(true);
  });

  it("dual control: first reviewer records intent, self-confirmation refused, second decides", async () => {
    const queue = await getReviewQueue(db, reviewer1, orgId, { riskLevel: "high" });
    const target = queue[0] as { id: string };
    const first = await decideReviewCaseDual(db, reviewer1, orgId, target.id, "approved", "Verified against enrolment record manually.");
    expect(first).toEqual({ status: "awaiting_second_approval", final: false });
    await expect(decideReviewCaseDual(db, reviewer1, orgId, target.id, "approved", "Confirming my own decision."))
      .rejects.toMatchObject({ code: "DUAL_CONTROL_SELF_REFUSED" });
    const second = await decideReviewCaseDual(db, reviewer2, orgId, target.id, "approved", "Independent check agrees.");
    expect(second).toEqual({ status: "approved", final: true });
    expect(await verifyAuditChain(db)).toBe(true);
  });

  it("liveness exception is refused unless the tenant explicitly enables it, then requires dual control", async () => {
    const rejected = await verify("p4person", "subj-p4", { live: false, attackType: "replay" });
    expect(rejected).toMatchObject({ decision: "rejected", reasonCode: "LIVENESS_FAILED" });

    await expect(escalateLivenessException(db, reviewer1, orgId, rejected.verificationId, "Member present in clinic with staff."))
      .rejects.toMatchObject({ code: "LIVENESS_EXCEPTION_DISABLED" });

    await db.query(
      `INSERT INTO org_settings (organisation_id, allow_liveness_exception, review_sla_minutes, updated_by)
       VALUES ($1, TRUE, 120, $2)`,
      [orgId, ownerCtx.userId],
    );
    const caseId = await escalateLivenessException(db, reviewer1, orgId, rejected.verificationId, "Member present in clinic with staff.");
    expect(caseId).toBeTruthy();
    // dual control enforced on the exception case
    const first = await decideReviewCaseDual(db, reviewer1, orgId, caseId, "approved", "Present in person, staff verified.");
    expect(first.final).toBe(false);
    const second = await decideReviewCaseDual(db, reviewer2, orgId, caseId, "approved", "Countersigned after checking audit trail.");
    expect(second.final).toBe(true);
    // cannot escalate the same verification twice
    await expect(escalateLivenessException(db, reviewer1, orgId, rejected.verificationId, "Trying again should fail."))
      .rejects.toMatchObject({ code: "ALREADY_ESCALATED" });
  });

  it("only rejected LIVENESS_FAILED attempts are escalatable, and non-reviewers are refused", async () => {
    const ok = await verify("p4person", "subj-p4");
    await expect(escalateLivenessException(db, reviewer1, orgId, ok.verificationId, "Not a liveness failure at all."))
      .rejects.toMatchObject({ code: "NOT_ESCALATABLE" });
    await expect(getReviewQueue(db, ownerCtx, orgId, {})).rejects.toThrow(/does not grant/);
  });

  it("feedback summary aggregates failure reasons with safe retry tips", async () => {
    const summary = await getCaptureFeedbackSummary(db, ownerCtx, orgId);
    expect(summary.length).toBeGreaterThan(0);
    const quality = summary.find((s) => s.reasonCode === "CAPTURE_QUALITY_INSUFFICIENT");
    expect(quality?.retryTip).toBe(RETRY_TIPS.CAPTURE_QUALITY_INSUFFICIENT);
    for (const tip of Object.values(RETRY_TIPS)) expect(tip).not.toMatch(/score|threshold|model/i);
  });
});

describe("fraud controls", () => {
  it("records attestation and flags untrusted devices as high-severity signals", async () => {
    const adapter = new NoopAttestationAdapter();
    const session = await createCaptureSession(db, principal, "verification");
    const result = await recordAttestation(db, orgId, session.captureSessionId, adapter, "synthetic:untrusted");
    expect(result.verdict).toBe("untrusted");
    const signals = await db.query(`SELECT * FROM risk_signals WHERE kind = 'attestation_untrusted'`);
    expect(signals.rows.length).toBe(1);
  });

  it("velocity anomalies produce high-severity signals", async () => {
    const store = new MemoryRateLimitStore();
    const subject = await db.query<{ id: string }>(`SELECT id FROM subjects WHERE subject_ref = 'subj-p4'`);
    let anomalous = false;
    for (let i = 0; i < 12; i++) {
      ({ anomalous } = await checkVelocity(db, store, orgId, subject.rows[0].id));
    }
    expect(anomalous).toBe(true);
  });

  it("detects the same capture reused across different subjects", async () => {
    const bytes = face("dup-capture");
    const s1 = randomUUID(), s2 = randomUUID();
    await db.query(`INSERT INTO subjects (id, organisation_id, project_id, subject_ref) VALUES ($1,$2,$3,'dup-a')`,
      [s1, orgId, principal.projectId]);
    await db.query(`INSERT INTO subjects (id, organisation_id, project_id, subject_ref) VALUES ($1,$2,$3,'dup-b')`,
      [s2, orgId, principal.projectId]);
    expect((await checkDuplicateCapture(db, orgId, s1, bytes)).duplicate).toBe(false);
    expect((await checkDuplicateCapture(db, orgId, s2, bytes)).duplicate).toBe(true);
  });

  it("high-severity risk signals downgrade an approval to review — never auto-reject", async () => {
    const session = await createCaptureSession(db, principal, "enrolment");
    await enrolSubject(db, principal, provider, {
      subjectRef: "subj-risky", captureSessionToken: session.clientToken, imageBytes: face("risky"), consent: CONSENT,
    });
    const subject = await db.query<{ id: string }>(`SELECT id FROM subjects WHERE subject_ref = 'subj-risky'`);
    await recordRiskSignal(db, orgId, { subjectId: subject.rows[0].id, kind: "duplicate_capture", severity: "high" });
    expect(await shouldRouteToReview(db, orgId, subject.rows[0].id)).toBe(true);
    const outcome = await verify("risky", "subj-risky");
    expect(outcome).toMatchObject({ decision: "review", reasonCode: "RISK_SIGNAL_REVIEW" });
    // a genuine rejection stays a rejection — signals never flip reject → approve
    const wrong = await verify("someone-else", "subj-risky");
    expect(wrong.decision).toBe("rejected");
  });

  it("risk signal details pass the same redaction guard as audit", async () => {
    await expect(recordRiskSignal(db, orgId, {
      kind: "test", severity: "info", detail: { selfie_image: "raw" },
    })).rejects.toThrow(/may not contain/);
  });
});
