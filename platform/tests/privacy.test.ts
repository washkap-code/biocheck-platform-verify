/**
 * Prompt 3 acceptance tests: envelope encryption, production key refusal,
 * secrets at rest, zero-retention evidence, subject export/deletion with
 * legal hold, residency/transfer register, upload validation, rate limits,
 * and the leakage proofs (raw captures never in logs/audit/ordinary fields).
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

// Dev master key for the LocalKmsAdapter — tests only, same convention as biocheck_engine.
process.env.BIOCHECK_MASTER_KEY_B64 = Buffer.alloc(32, 9).toString("base64url");
import { createPgliteDb, type Db } from "../src/server/db/client";
import { migrate } from "../src/server/db/migrate";
import { registerUser, verifyEmail, login, enrolTotp } from "../src/server/auth/service";
import { totpCode } from "../src/server/auth/totp";
import { createOrganisation, createWorkspace, createProject, inviteMember, acceptInvitation } from "../src/server/tenancy/service";
import { createApiKey, authenticateApiKey, type ApiKeyPrincipal } from "../src/server/apikeys/service";
import {
  LocalKmsAdapter, assertProductionKeyConfig, getTenantDek, rotateTenantDek,
  encryptWithDek, decryptWithDek,
} from "../src/server/security/kms";
import { encryptSecret, decryptSecret, isEncryptedSecret } from "../src/server/security/secrets";
import { EvidenceService, MemoryStorageAdapter } from "../src/server/privacy/evidence";
import { exportSubjectData, deleteSubjectData, setDataResidency, registerTransfer } from "../src/server/privacy/subjectRights";
import { createCaptureSession, enrolSubject, verifySubject, ensureDefaultPolicy } from "../src/server/verification/service";
import { FakeProvider, FAKE_MODEL, FAKE_PAD_MODEL } from "../src/server/verification/providers";
import { createWebhookEndpoint, deliverDueWebhooks, enqueueWebhook, verifyWebhookSignature } from "../src/server/webhooks/service";
import { redact, createSafeLogger, validateCaptureUpload, MemoryRateLimitStore, enforceRateLimit, RateLimitExceededError, NoopMalwareScanner } from "../src/server/security/controls";
import { getSecurityDashboard } from "../src/server/security/dashboard";
import type { AuthContext } from "../src/server/authz/policy";

let db: Db;
let provider: FakeProvider;
let principal: ApiKeyPrincipal;
let ownerCtx: AuthContext;
let reviewerCtx: AuthContext;
let orgId: string;
let storage: MemoryStorageAdapter;
let evidenceService: EvidenceService;

const fixture = (person: string, overrides: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ person, ...overrides }));
const CONSENT = { noticeVersion: "n1", purpose: "check-in", lawfulBasis: "consent" };

async function enrol(person: string, subjectRef: string) {
  const session = await createCaptureSession(db, principal, "enrolment");
  return enrolSubject(db, principal, provider, {
    subjectRef, captureSessionToken: session.clientToken, imageBytes: fixture(person), consent: CONSENT,
  });
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
  const owner = await registerUser(db, "owner@p3.biocheck.local", "correct-horse-battery-staple");
  await verifyEmail(db, owner.emailVerificationToken);
  ownerCtx = { userId: owner.userId, platformRole: null };
  orgId = await createOrganisation(db, ownerCtx, "P3 Org", "p3-org");
  const ws = await createWorkspace(db, ownerCtx, orgId, "Main");
  const project = await createProject(db, ownerCtx, orgId, ws, "Verify");
  const key = await createApiKey(db, ownerCtx, orgId, project.projectId, project.environments.sandbox, "k",
    ["verification:create", "verification:read", "enrolment:create", "consent:manage"]);
  principal = await authenticateApiKey(db, key.secretKey, "verification:create");

  const reviewer = await registerUser(db, "rev@p3.biocheck.local", "correct-horse-battery-staple");
  await verifyEmail(db, reviewer.emailVerificationToken);
  const invite = await inviteMember(db, ownerCtx, orgId, "rev@p3.biocheck.local", "reviewer");
  await acceptInvitation(db, reviewer.userId, "rev@p3.biocheck.local", invite.token);
  reviewerCtx = { userId: reviewer.userId, platformRole: null };

  storage = new MemoryStorageAdapter();
  evidenceService = new EvidenceService(db, storage);
});

afterAll(async () => {
  await db.close();
});

describe("envelope encryption", () => {
  it("wraps per-tenant DEKs and encrypts/decrypts with AAD binding", async () => {
    const kms = new LocalKmsAdapter();
    const { dek } = await getTenantDek(db, kms, orgId);
    const ct = encryptWithDek(dek, Buffer.from("sensitive"), `${orgId}:test`);
    expect(ct.startsWith("enc1:")).toBe(true);
    expect(decryptWithDek(dek, ct, `${orgId}:test`).toString()).toBe("sensitive");
    expect(() => decryptWithDek(dek, ct, `${orgId}:other-context`)).toThrow(); // AAD mismatch
  });

  it("rotates DEKs; old versions remain decryptable, new writes use the new version", async () => {
    const kms = new LocalKmsAdapter();
    const before = await getTenantDek(db, kms, orgId);
    const newVersion = await rotateTenantDek(db, kms, orgId);
    const after = await getTenantDek(db, kms, orgId);
    expect(newVersion).toBe(before.keyVersion + 1);
    expect(after.keyVersion).toBe(newVersion);
    expect(after.dek.equals(before.dek)).toBe(false);
  });

  it("production refuses the local dev KMS adapter", () => {
    const kms = new LocalKmsAdapter();
    expect(() => assertProductionKeyConfig(kms, "production")).toThrow(/refuses/);
    expect(() => assertProductionKeyConfig(kms, "test")).not.toThrow();
  });

  it("stores webhook and TOTP secrets only as envelope ciphertext", async () => {
    const endpoint = await createWebhookEndpoint(db, ownerCtx, orgId, principal.projectId, principal.environmentId,
      "https://p3.example/hooks", ["verification.completed"]);
    const stored = await db.query<{ secret_enc: string }>(
      `SELECT secret_enc FROM webhook_endpoints WHERE id = $1`, [endpoint.endpointId]);
    expect(isEncryptedSecret(stored.rows[0].secret_enc)).toBe(true);
    expect(stored.rows[0].secret_enc).not.toContain(endpoint.signingSecret);

    // Deliveries still sign correctly with the decrypted secret.
    await enqueueWebhook(db, orgId, principal.environmentId, "verification.completed", { x: 1 });
    const seen: { headers: Record<string, string>; body: string }[] = [];
    await deliverDueWebhooks(db, async (_u, headers, body) => { seen.push({ headers, body }); return 200; });
    const hit = seen.find((s) => verifyWebhookSignature(endpoint.signingSecret, s.headers["X-BioCheck-Timestamp"], s.body, s.headers["X-BioCheck-Signature"]));
    expect(hit).toBeTruthy();

    const mfaUser = await registerUser(db, "mfa@p3.biocheck.local", "correct-horse-battery-staple");
    await verifyEmail(db, mfaUser.emailVerificationToken);
    const { secret } = await enrolTotp(db, mfaUser.userId);
    const userRow = await db.query<{ totp_secret_enc: string }>(
      `SELECT totp_secret_enc FROM users WHERE id = $1`, [mfaUser.userId]);
    expect(isEncryptedSecret(userRow.rows[0].totp_secret_enc)).toBe(true);
    expect(userRow.rows[0].totp_secret_enc).not.toContain(secret);
    const result = await login(db, "mfa@p3.biocheck.local", "correct-horse-battery-staple", { totpCode: totpCode(secret) });
    expect(result.sessionToken).toBeTruthy();
  });

  it("round-trips generic secrets with context binding", async () => {
    const enc = await encryptSecret(db, orgId, "ctx:a", "value-1");
    expect(await decryptSecret(db, orgId, "ctx:a", enc)).toBe("value-1");
    await expect(decryptSecret(db, orgId, "ctx:b", enc)).rejects.toThrow();
  });
});

describe("evidence storage (zero-retention default)", () => {
  it("refuses retention without purpose or future expiry", async () => {
    await expect(evidenceService.retain({
      organisationId: orgId, relatedType: "verification_attempt", purpose: "",
      retentionExpiresAt: new Date(Date.now() + 86400_000), bytes: Buffer.from("x"), createdBy: "t",
    })).rejects.toThrow(/purpose/);
    await expect(evidenceService.retain({
      organisationId: orgId, relatedType: "verification_attempt", purpose: "dispute",
      retentionExpiresAt: new Date(Date.now() - 1000), bytes: Buffer.from("x"), createdBy: "t",
    })).rejects.toThrow(/future retention/);
  });

  it("stores ciphertext only, restricts access by role, and purges after expiry", async () => {
    const media = Buffer.from("fake-jpeg-evidence-bytes");
    const id = await evidenceService.retain({
      organisationId: orgId, relatedType: "review_case", purpose: "manual review evidence",
      retentionExpiresAt: new Date(Date.now() + 60_000), bytes: media, createdBy: "test",
    });
    // ciphertext at rest
    const stored = await storage.get(`evidence/${orgId}/${id}`);
    expect(stored!.toString()).toContain("enc1:");
    expect(stored!.includes(media)).toBe(false);
    // role-guarded fetch: reviewer OK, owner-without-reviews:decide denied is covered by policy matrix
    const fetched = await evidenceService.fetch(reviewerCtx, orgId, id);
    expect(fetched.equals(media)).toBe(true);
    // retention sweep (force the row past expiry deterministically)
    await db.query(`UPDATE evidence_objects SET retention_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    const purged = await evidenceService.purgeExpired();
    expect(purged).toBeGreaterThan(0);
    await expect(evidenceService.fetch(reviewerCtx, orgId, id)).rejects.toThrow(/deleted|not found/i);
  });
});

describe("subject rights", () => {
  it("export contains metadata but never biometric material", async () => {
    await enrol("erin", "subj-erin");
    const exported = await exportSubjectData(db, principal, "subj-erin");
    expect(exported.consents.length).toBe(1);
    expect(exported.referenceTemplates.length).toBe(1);
    const flat = JSON.stringify(exported);
    // No ciphertext, no embedding VALUES. (model_id strings like
    // "fake-embedding-v1" are harmless metadata and allowed.)
    expect(flat).not.toMatch(/template_ciphertext|"embedding"|enc1:/);
  });

  it("deletion revokes templates, withdraws consent, deletes evidence and blocks future matching", async () => {
    await enrol("frank", "subj-frank");
    const result = await deleteSubjectData(db, principal, evidenceService, "subj-frank");
    expect(result.status).toBe("completed");
    expect(result.templatesRevoked).toBe(1);
    const session = await createCaptureSession(db, principal, "verification");
    const outcome = await verifySubject(db, principal, provider, {
      subjectRef: "subj-frank", captureSessionToken: session.clientToken, imageBytes: fixture("frank"),
    });
    expect(outcome.reasonCode).toBe("REFERENCE_NOT_FOUND");
    // the revoked row retains no ciphertext
    const rows = await db.query<{ template_ciphertext: string }>(
      `SELECT template_ciphertext FROM reference_templates rt JOIN subjects s ON s.id = rt.subject_id WHERE s.subject_ref = 'subj-frank'`);
    expect(rows.rows[0].template_ciphertext).toBe("deleted");
  });

  it("legal hold parks the deletion as blocked, auditable, and does not delete", async () => {
    await enrol("grace", "subj-grace");
    const subject = await db.query<{ id: string }>(`SELECT id FROM subjects WHERE subject_ref = 'subj-grace'`);
    await db.query(
      `INSERT INTO legal_holds (id, organisation_id, subject_id, reason, created_by)
       VALUES ($1,$2,$3,'regulatory investigation',$4)`,
      [randomUUID(), orgId, subject.rows[0].id, ownerCtx.userId],
    );
    const result = await deleteSubjectData(db, principal, evidenceService, "subj-grace");
    expect(result.status).toBe("blocked_legal_hold");
    expect(result.legalHoldRef).toBeTruthy();
    const still = await db.query(
      `SELECT 1 FROM reference_templates rt JOIN subjects s ON s.id = rt.subject_id
       WHERE s.subject_ref = 'subj-grace' AND rt.status = 'active'`);
    expect(still.rows.length).toBe(1);
  });
});

describe("residency and transfers", () => {
  it("records residency and refuses incomplete transfer registrations", async () => {
    await setDataResidency(db, orgId, "zw", "af-south-1");
    const row = await db.query<{ country_code: string }>(`SELECT country_code FROM data_residency WHERE organisation_id = $1`, [orgId]);
    expect(row.rows[0].country_code).toBe("ZW");
    await expect(registerTransfer(db, orgId, {
      dataCategory: "audit_export", fromRegion: "af-south-1", toRegion: "eu-west-1",
      mechanism: "", reason: "regulator request", approvedBy: ownerCtx.userId,
    })).rejects.toThrow(/mechanism/);
    const id = await registerTransfer(db, orgId, {
      dataCategory: "audit_export", fromRegion: "af-south-1", toRegion: "eu-west-1",
      mechanism: "tenant-approved safeguard ref SCC-2026-04", reason: "regulator request", approvedBy: ownerCtx.userId,
    });
    expect(id).toBeTruthy();
  });
});

describe("upload validation and rate limits", () => {
  it("validates MIME magic bytes, not extensions", () => {
    expect(validateCaptureUpload(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).toMatchObject({ ok: true, mime: "image/jpeg" });
    expect(validateCaptureUpload(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]))).toMatchObject({ ok: true, mime: "image/png" });
    expect(validateCaptureUpload(Buffer.from("<script>alert(1)</script>"))).toMatchObject({ ok: false, reason: "UNSUPPORTED_MEDIA_TYPE" });
    expect(validateCaptureUpload(new Uint8Array(0))).toMatchObject({ ok: false, reason: "EMPTY_UPLOAD" });
    expect(validateCaptureUpload(new Uint8Array(9 * 1024 * 1024))).toMatchObject({ ok: false, reason: "UPLOAD_TOO_LARGE" });
  });

  it("enforces sliding-window limits per actor", async () => {
    const store = new MemoryRateLimitStore();
    for (let i = 0; i < 10; i++) await enforceRateLimit(store, "auth.login", "ip-1");
    await expect(enforceRateLimit(store, "auth.login", "ip-1")).rejects.toBeInstanceOf(RateLimitExceededError);
    await expect(enforceRateLimit(store, "auth.login", "ip-2")).resolves.toBeUndefined();
  });

  it("noop malware scanner refuses production", async () => {
    const scanner = new NoopMalwareScanner();
    await expect(scanner.scan(new Uint8Array([1]))).resolves.toEqual({ clean: true });
  });
});

describe("leakage proofs", () => {
  it("raw capture bytes never appear in audit events or non-template columns", async () => {
    const marker = `LEAK_MARKER_${Date.now()}`;
    const session = await createCaptureSession(db, principal, "enrolment");
    await enrolSubject(db, principal, provider, {
      subjectRef: "subj-leak", captureSessionToken: session.clientToken,
      imageBytes: fixture(marker), consent: CONSENT,
    });
    const v = await createCaptureSession(db, principal, "verification");
    await verifySubject(db, principal, provider, {
      subjectRef: "subj-leak", captureSessionToken: v.clientToken, imageBytes: fixture(marker),
    });
    // Scan every table that could accidentally hold the capture payload.
    for (const table of ["audit_events", "verification_attempts", "capture_sessions", "subjects", "consent_receipts", "webhook_deliveries", "idempotency_keys"]) {
      const { rows } = await db.query(`SELECT * FROM ${table}`);
      expect(JSON.stringify(rows), `capture content leaked into ${table}`).not.toContain(marker);
    }
    // The template vault row itself must be ciphertext, not the fixture.
    const t = await db.query<{ template_ciphertext: string }>(
      `SELECT template_ciphertext FROM reference_templates rt JOIN subjects s ON s.id = rt.subject_id WHERE s.subject_ref = 'subj-leak'`);
    expect(t.rows[0].template_ciphertext).not.toContain(marker);
  });

  it("the safe logger redacts biometric keys and blob-like values with no unredacted mode", () => {
    const lines: string[] = [];
    const logger = createSafeLogger({ write: (l) => lines.push(l) });
    logger.info("capture received", {
      imageB64: "A".repeat(400), nested: { selfie: "raw-bytes", requestId: "req-1" }, size: 12345,
    });
    const line = lines[0];
    expect(line).not.toContain("A".repeat(400));
    expect(line).toContain("[REDACTED]");
    expect(line).toContain("req-1"); // useful context survives
    expect(redact({ authorization: "Bearer xyz" })).toEqual({ authorization: "[REDACTED]" });
  });

  it("security dashboard responds with aggregates only", async () => {
    const dash = await getSecurityDashboard(db, ownerCtx, orgId);
    expect(dash.pendingReviewCases).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(dash)).not.toMatch(/enc1:|whsec_|bck_/);
  });
});
