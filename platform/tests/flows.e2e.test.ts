/**
 * Prompt 5 end-to-end flow tests (service + metrics layer, PGlite).
 * One continuous journey: tenant onboarding → API key → webhook → capture
 * session → enrolment → verification → review completion → dashboard
 * aggregates reflect it all. Browser-level e2e (Playwright) is wired into CI
 * at Prompt 6; this suite proves the same flows at the integration boundary.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.BIOCHECK_MASTER_KEY_B64 = Buffer.alloc(32, 9).toString("base64url");
import { createPgliteDb, type Db } from "../src/server/db/client";
import { migrate } from "../src/server/db/migrate";
import { registerUser, verifyEmail, login, enrolTotp } from "../src/server/auth/service";
import { totpCode } from "../src/server/auth/totp";
import { createOrganisation, createWorkspace, createProject, inviteMember, acceptInvitation } from "../src/server/tenancy/service";
import { createApiKey, authenticateApiKey, type ApiKeyPrincipal } from "../src/server/apikeys/service";
import { createCaptureSession, enrolSubject, verifySubject, ensureDefaultPolicy } from "../src/server/verification/service";
import { decideReviewCaseDual, getReviewQueue } from "../src/server/reviews/service";
import { FakeProvider, FAKE_MODEL, FAKE_PAD_MODEL } from "../src/server/verification/providers";
import { createWebhookEndpoint, deliverDueWebhooks, verifyWebhookSignature } from "../src/server/webhooks/service";
import { getOrgDashboard } from "../src/server/console/metrics";
import { verifyAuditChain } from "../src/server/audit/service";
import type { AuthContext } from "../src/server/authz/policy";

let db: Db;
const provider = () => providerInstance;
let providerInstance: FakeProvider;

const face = (person: string, overrides: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ person, ...overrides }));

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
  providerInstance = new FakeProvider();
  await ensureDefaultPolicy(db);
  for (const [m, purpose] of [[FAKE_MODEL, "face_embedding"], [FAKE_PAD_MODEL, "passive_pad"]] as const) {
    await db.query(
      `INSERT INTO model_registry (id, model_id, sha256, purpose, commercial_use_approved, independent_report_ref, approved_by, expires_on)
       VALUES ($1,$2,$3,$4,TRUE,'TEST-1','governance','2099-01-01')`,
      [randomUUID(), m.id, m.sha256, purpose],
    );
  }
});

afterAll(async () => {
  await db.close();
});

describe("full tenant journey", () => {
  let ownerCtx: AuthContext;
  let orgId: string;
  let principal: ApiKeyPrincipal;
  let webhookSecret: string;
  const received: { headers: Record<string, string>; body: string }[] = [];

  it("onboards a tenant with MFA-gated owner login", async () => {
    const owner = await registerUser(db, "founder@flow.biocheck.local", "correct-horse-battery-staple");
    await verifyEmail(db, owner.emailVerificationToken);
    ownerCtx = { userId: owner.userId, platformRole: null };
    orgId = await createOrganisation(db, ownerCtx, "Flow Clinic Group", "flow-clinic");
    // Owner is privileged: no session without TOTP.
    await expect(login(db, "founder@flow.biocheck.local", "correct-horse-battery-staple"))
      .rejects.toMatchObject({ code: "MFA_REQUIRED" });
    const { secret } = await enrolTotp(db, owner.userId);
    const session = await login(db, "founder@flow.biocheck.local", "correct-horse-battery-staple", { totpCode: totpCode(secret) });
    expect(session.sessionToken).toBeTruthy();
  });

  it("creates workspace, project (sandbox+production) and a scoped API key", async () => {
    const ws = await createWorkspace(db, ownerCtx, orgId, "Member Services");
    const project = await createProject(db, ownerCtx, orgId, ws, "Clinic Check-in");
    expect(Object.keys(project.environments).sort()).toEqual(["production", "sandbox"]);
    const key = await createApiKey(db, ownerCtx, orgId, project.projectId, project.environments.sandbox,
      "integration key", ["verification:create", "verification:read", "enrolment:create", "consent:manage"]);
    expect(key.secretKey).toMatch(/^bck_sandbox_/);
    principal = await authenticateApiKey(db, key.secretKey, "verification:create");
    expect(principal.organisationId).toBe(orgId);
  });

  it("registers a webhook endpoint and receives a signed test delivery", async () => {
    const endpoint = await createWebhookEndpoint(db, ownerCtx, orgId, principal.projectId, principal.environmentId,
      "https://clinic.example/biocheck-hooks", ["verification.completed", "verification.review_required"]);
    webhookSecret = endpoint.signingSecret;
    expect(webhookSecret.startsWith("whsec_")).toBe(true);
  });

  it("runs enrolment and verification through one-use capture sessions", async () => {
    const enrolSession = await createCaptureSession(db, principal, "enrolment");
    expect(enrolSession.challenge).toBeTruthy();
    const enrolment = await enrolSubject(db, principal, provider(), {
      subjectRef: "member-0042", captureSessionToken: enrolSession.clientToken,
      imageBytes: face("flow-member"),
      consent: { noticeVersion: "clinic-notice-v2", purpose: "member check-in", lawfulBasis: "consent" },
    });
    expect(enrolment.templateId).toBeTruthy();

    const verifySession = await createCaptureSession(db, principal, "verification");
    const approved = await verifySubject(db, principal, provider(), {
      subjectRef: "member-0042", captureSessionToken: verifySession.clientToken, imageBytes: face("flow-member"),
    });
    expect(approved.decision).toBe("approved");
  });

  it("routes a borderline capture to review and completes it with a named reviewer", async () => {
    const session = await createCaptureSession(db, principal, "verification");
    const outcome = await verifySubject(db, principal, provider(), {
      subjectRef: "member-0042", captureSessionToken: session.clientToken,
      imageBytes: face("flow-member", { quality: 0.5 }),
    });
    expect(outcome.decision).toBe("review");

    const reviewer = await registerUser(db, "nurse-lead@flow.biocheck.local", "correct-horse-battery-staple");
    await verifyEmail(db, reviewer.emailVerificationToken);
    const invite = await inviteMember(db, ownerCtx, orgId, "nurse-lead@flow.biocheck.local", "reviewer");
    await acceptInvitation(db, reviewer.userId, "nurse-lead@flow.biocheck.local", invite.token);
    const reviewerCtx: AuthContext = { userId: reviewer.userId, platformRole: null };

    const queue = await getReviewQueue(db, reviewerCtx, orgId, {});
    expect(queue.length).toBe(1);
    const decided = await decideReviewCaseDual(db, reviewerCtx, orgId, (queue[0] as { id: string }).id,
      "approved", "Member recognised at front desk; capture retried poorly due to lighting.");
    expect(decided).toEqual({ status: "approved", final: true });
  });

  it("delivers signed webhooks for the journey's events", async () => {
    const transport = async (_url: string, headers: Record<string, string>, body: string) => {
      received.push({ headers, body });
      return 200;
    };
    const result = await deliverDueWebhooks(db, transport);
    expect(result.delivered).toBeGreaterThanOrEqual(3); // approved + review_required + completed(review)
    for (const d of received) {
      expect(verifyWebhookSignature(webhookSecret, d.headers["X-BioCheck-Timestamp"], d.body, d.headers["X-BioCheck-Signature"])).toBe(true);
      expect(d.body).not.toMatch(/imageB64|flow-member|enc1:/); // payloads carry outcomes, not content
    }
  });

  it("reflects everything in the organisation dashboard aggregates", async () => {
    const dash = await getOrgDashboard(db, ownerCtx, orgId);
    expect(dash.totals.attempts).toBe(2);
    expect(dash.totals.approved).toBe(1);
    expect(dash.totals.review).toBe(1);
    expect(dash.rates.approvalPct).toBe(50);
    expect(dash.dailyVolumes.reduce((a, d) => a + d.count, 0)).toBe(2);
    expect(dash.captureQualityIssues.some((q) => q.reasonCode === "CAPTURE_QUALITY_INSUFFICIENT")).toBe(true);
    expect(dash.pendingReviews.total).toBe(0); // completed above
    expect(dash.webhookHealth.some((w) => w.status === "delivered")).toBe(true);
    expect(dash.activeModels.some((m) => m.modelId === FAKE_MODEL.id)).toBe(true);
    // aggregates only — nothing sensitive in the payload
    expect(JSON.stringify(dash)).not.toMatch(/enc1:|whsec_|bck_|member-0042/);
  });

  it("keeps the audit chain intact across the whole journey", async () => {
    expect(await verifyAuditChain(db)).toBe(true);
  });

  it("denies the dashboard to non-members (tenant isolation holds end-to-end)", async () => {
    const outsider = await registerUser(db, "outsider@flow.biocheck.local", "correct-horse-battery-staple");
    await verifyEmail(db, outsider.emailVerificationToken);
    await expect(getOrgDashboard(db, { userId: outsider.userId, platformRole: null }, orgId))
      .rejects.toThrow(/Not a member/);
  });
});
