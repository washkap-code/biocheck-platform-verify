/**
 * Prompt 1 acceptance tests: tenant isolation, role checks, API-key scope
 * enforcement, audit-chain verification, auth controls.
 * Runs on PGlite (real Postgres semantics, in-process).
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";

// Dev master key for envelope encryption (LocalKmsAdapter) — tests only.
process.env.BIOCHECK_MASTER_KEY_B64 = Buffer.alloc(32, 9).toString("base64url");
import { createPgliteDb, type Db } from "../src/server/db/client";
import { migrate } from "../src/server/db/migrate";
import {
  registerUser, verifyEmail, login, rotateSession, resolveSession, enrolTotp, AuthError,
} from "../src/server/auth/service";
import { totpCode } from "../src/server/auth/totp";
import {
  createOrganisation, createProject, createWorkspace, listProjects, inviteMember, acceptInvitation,
} from "../src/server/tenancy/service";
import { createApiKey, authenticateApiKey, revokeApiKey } from "../src/server/apikeys/service";
import {
  appendAudit, verifyAuditChain, queryAudit, exportAuditCsv, assertSafeDetails, AuditRedactionError,
} from "../src/server/audit/service";
import { AuthorizationError, authorize, type AuthContext } from "../src/server/authz/policy";

let db: Db;

/** Registered + verified user helper. */
async function makeUser(email: string, password = "correct-horse-battery-staple") {
  const { userId, emailVerificationToken } = await registerUser(db, email, password);
  await verifyEmail(db, emailVerificationToken);
  return { userId, email, password, ctx: { userId, platformRole: null } as AuthContext };
}

let ownerA: Awaited<ReturnType<typeof makeUser>>;
let ownerB: Awaited<ReturnType<typeof makeUser>>;
let orgA: string;
let orgB: string;
let projectA: { projectId: string; environments: Record<string, string> };

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
  ownerA = await makeUser("owner-a@demo.biocheck.local");
  ownerB = await makeUser("owner-b@demo.biocheck.local");
  orgA = await createOrganisation(db, ownerA.ctx, "Demo Health Group", "demo-health");
  orgB = await createOrganisation(db, ownerB.ctx, "Demo Bank", "demo-bank");
  const wsA = await createWorkspace(db, ownerA.ctx, orgA, "Clinical");
  projectA = await createProject(db, ownerA.ctx, orgA, wsA, "Member Verification");
});

afterAll(async () => {
  await db.close();
});

describe("tenant isolation", () => {
  it("denies a non-member reading another organisation's projects", async () => {
    await expect(listProjects(db, ownerB.ctx, orgA)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("does not trust a client-provided organisation id on writes", async () => {
    const wsB = await createWorkspace(db, ownerB.ctx, orgB, "Retail");
    // ownerB tries to create a project in orgA using their own workspace.
    await expect(createProject(db, ownerB.ctx, orgA, wsB, "Sneaky")).rejects.toBeInstanceOf(AuthorizationError);
    // ownerA cannot attach a project to a workspace of another organisation.
    await expect(createProject(db, ownerA.ctx, orgA, wsB, "Cross-tenant")).rejects.toThrow(/does not belong/);
  });

  it("scopes project listings to the authorised organisation only", async () => {
    const rows = await listProjects(db, ownerA.ctx, orgA);
    expect(rows.length).toBe(1);
    expect((rows[0] as { name: string }).name).toBe("Member Verification");
  });
});

describe("role checks (single policy layer)", () => {
  it("read_only member cannot create projects or API keys", async () => {
    const viewer = await makeUser("viewer@demo.biocheck.local");
    const invite = await inviteMember(db, ownerA.ctx, orgA, viewer.email, "read_only");
    await acceptInvitation(db, viewer.userId, viewer.email, invite.token);
    await expect(createProject(db, viewer.ctx, orgA, "any", "X")).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      createApiKey(db, viewer.ctx, orgA, projectA.projectId, projectA.environments.sandbox, "k", ["verification:read"]),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("analyst can read audit but cannot export is false — analyst lacks export", async () => {
    const analyst = await makeUser("analyst@demo.biocheck.local");
    const invite = await inviteMember(db, ownerA.ctx, orgA, analyst.email, "analyst");
    await acceptInvitation(db, analyst.userId, analyst.email, invite.token);
    await expect(queryAudit(db, analyst.ctx, orgA)).resolves.toBeInstanceOf(Array);
    await expect(exportAuditCsv(db, analyst.ctx, orgA)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("integration_developer can create API keys but cannot invite members", async () => {
    const dev = await makeUser("dev@demo.biocheck.local");
    const invite = await inviteMember(db, ownerA.ctx, orgA, dev.email, "integration_developer");
    await acceptInvitation(db, dev.userId, dev.email, invite.token);
    const key = await createApiKey(
      db, dev.ctx, orgA, projectA.projectId, projectA.environments.sandbox, "dev key", ["verification:read"],
    );
    expect(key.secretKey).toMatch(/^bck_sandbox_/);
    await expect(inviteMember(db, dev.ctx, orgA, "x@y.z", "read_only")).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("platform_security_admin may read audit across tenants but not create projects", async () => {
    const sec = await makeUser("secadmin@biocheck.local");
    await db.query(`UPDATE users SET platform_role = 'platform_security_admin' WHERE id = $1`, [sec.userId]);
    const ctx: AuthContext = { userId: sec.userId, platformRole: "platform_security_admin" };
    await expect(queryAudit(db, ctx, orgA)).resolves.toBeInstanceOf(Array);
    await expect(authorize(db, ctx, orgA, "projects:create")).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("membership invitation flow binds email and single-use token", async () => {
    const stranger = await makeUser("stranger@demo.biocheck.local");
    const invite = await inviteMember(db, ownerA.ctx, orgA, "intended@demo.biocheck.local", "reviewer");
    await expect(acceptInvitation(db, stranger.userId, stranger.email, invite.token)).rejects.toThrow(/different email/);
  });
});

describe("API key scope enforcement", () => {
  it("enforces scopes and environment binding", async () => {
    const key = await createApiKey(
      db, ownerA.ctx, orgA, projectA.projectId, projectA.environments.sandbox, "scoped", ["verification:read"],
    );
    const principal = await authenticateApiKey(db, key.secretKey, "verification:read");
    expect(principal.organisationId).toBe(orgA);
    expect(principal.environmentKind).toBe("sandbox");
    await expect(authenticateApiKey(db, key.secretKey, "verification:create")).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("rejects forged and revoked keys", async () => {
    await expect(authenticateApiKey(db, "bck_sandbox_deadbeef.notreal", "verification:read"))
      .rejects.toBeInstanceOf(AuthorizationError);
    const key = await createApiKey(
      db, ownerA.ctx, orgA, projectA.projectId, projectA.environments.production, "to-revoke", ["verification:create"],
    );
    await revokeApiKey(db, ownerA.ctx, orgA, key.apiKeyId);
    await expect(authenticateApiKey(db, key.secretKey, "verification:create")).rejects.toThrow(/revoked/);
  });

  it("cannot create a key for an environment of another organisation's project", async () => {
    await expect(
      createApiKey(db, ownerB.ctx, orgB, projectA.projectId, projectA.environments.sandbox, "x", ["verification:read"]),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("audit chain", () => {
  it("verifies an intact chain and records denied outcomes", async () => {
    expect(await verifyAuditChain(db)).toBe(true);
    const rows = await queryAudit(db, ownerA.ctx, orgA, { outcome: "denied" });
    expect(rows.some((r) => r.action === "apikey.scope_denied")).toBe(true);
  });

  it("is append-only at the database level", async () => {
    await expect(db.query(`UPDATE audit_events SET action = 'tampered' WHERE seq = 1`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM audit_events WHERE seq = 1`)).rejects.toThrow(/append-only/);
  });

  it("redaction guard refuses biometric/secret material in details", () => {
    expect(() => assertSafeDetails({ embedding: [0.1, 0.2] })).toThrow(AuditRedactionError);
    expect(() => assertSafeDetails({ nested: { selfie_image: "x" } })).toThrow(AuditRedactionError);
    expect(() => assertSafeDetails({ blob: "A".repeat(300) })).toThrow(AuditRedactionError);
    expect(() => assertSafeDetails({ reason: "quality_low", score_band: "review" })).not.toThrow();
  });

  it("refuses unsafe details at append time", async () => {
    await expect(
      appendAudit(db, {
        organisationId: orgA, actorType: "system", actorId: "test", action: "x",
        resourceType: "y", outcome: "success", details: { api_key: "leak" },
      }),
    ).rejects.toBeInstanceOf(AuditRedactionError);
  });

  it("exports CSV for authorised roles with no secret columns", async () => {
    const csv = await exportAuditCsv(db, ownerA.ctx, orgA);
    expect(csv.split("\n")[0]).toContain("event_hash");
    expect(csv).not.toMatch(/password|token_hash|secret/);
  });
});

describe("authentication controls", () => {
  it("locks the account after repeated failures", async () => {
    const u = await makeUser("lockout@demo.biocheck.local");
    for (let i = 0; i < 5; i++) {
      await expect(login(db, u.email, "wrong-password-123")).rejects.toBeInstanceOf(AuthError);
    }
    await expect(login(db, u.email, u.password)).rejects.toMatchObject({ code: "LOCKED" });
  });

  it("requires verified email and enforces the password policy", async () => {
    await expect(registerUser(db, "weak@demo.biocheck.local", "short")).rejects.toMatchObject({ code: "WEAK_PASSWORD" });
    const { } = await registerUser(db, "unverified@demo.biocheck.local", "a-long-enough-password");
    await expect(login(db, "unverified@demo.biocheck.local", "a-long-enough-password"))
      .rejects.toMatchObject({ code: "EMAIL_UNVERIFIED" });
  });

  it("rotates sessions and invalidates the previous token", async () => {
    const u = await makeUser("rotate@demo.biocheck.local");
    const { sessionToken } = await login(db, u.email, u.password);
    const next = await rotateSession(db, sessionToken);
    expect(await resolveSession(db, sessionToken)).toBeNull();
    expect(await resolveSession(db, next)).not.toBeNull();
  });

  it("blocks privileged roles without MFA and accepts TOTP when enrolled", async () => {
    // ownerA is organisation_owner (privileged) and has no MFA yet.
    await expect(login(db, ownerA.email, ownerA.password)).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    const { secret } = await enrolTotp(db, ownerA.userId);
    await expect(login(db, ownerA.email, ownerA.password)).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    const result = await login(db, ownerA.email, ownerA.password, { totpCode: totpCode(secret) });
    expect(result.sessionToken).toBeTruthy();
    await expect(login(db, ownerA.email, ownerA.password, { totpCode: "000000" }))
      .rejects.toMatchObject({ code: "MFA_INVALID" });
  });
});
