/**
 * Seeds FAKE demonstration data only. Every value is clearly fictional and
 * safe to show in demos. No real customers, no real people, no biometrics.
 */
import { createPgliteDb, createPostgresDb } from "./client";
import { migrate } from "./migrate";
import { registerUser, verifyEmail, enrolTotp } from "../auth/service";
import { createOrganisation, createWorkspace, createProject, inviteMember, acceptInvitation } from "../tenancy/service";
import { createApiKey } from "../apikeys/service";

export async function seed(db: Awaited<ReturnType<typeof createPgliteDb>>) {
  const demo = async (email: string) => {
    const u = await registerUser(db, email, "demo-password-change-me");
    await verifyEmail(db, u.emailVerificationToken);
    return u.userId;
  };

  const ownerId = await demo("demo-owner@biocheck-demo.example");
  await enrolTotp(db, ownerId); // privileged roles require MFA
  const ownerCtx = { userId: ownerId, platformRole: null };

  const orgId = await createOrganisation(db, ownerCtx, "Demonstration Health Group (FAKE)", "demo-health-group");
  const wsId = await createWorkspace(db, ownerCtx, orgId, "Member Services");
  const { projectId, environments } = await createProject(db, ownerCtx, orgId, wsId, "Clinic Check-in (Demo)");

  const devId = await demo("demo-developer@biocheck-demo.example");
  const invite = await inviteMember(db, ownerCtx, orgId, "demo-developer@biocheck-demo.example", "integration_developer");
  await acceptInvitation(db, devId, "demo-developer@biocheck-demo.example", invite.token);

  const key = await createApiKey(
    db, { userId: devId, platformRole: null }, orgId, projectId, environments.sandbox,
    "Demo sandbox key", ["verification:create", "verification:read"],
  );
  console.log("Seeded fake demo organisation.");
  console.log("Sandbox API key (shown once, demo only):", key.secretKey);
  return { orgId, projectId, environments };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  const db = url ? await createPostgresDb(url) : await createPgliteDb();
  if (!url) console.log("No DATABASE_URL — seeding an ephemeral PGlite database (dry run).");
  await migrate(db);
  await seed(db);
  await db.close();
}
