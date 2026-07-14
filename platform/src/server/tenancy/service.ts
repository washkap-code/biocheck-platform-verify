/**
 * Tenancy: organisation → workspace → project → environments (sandbox/production).
 * Every read/write goes through authorize(); reads are always scoped by the
 * server-resolved organisation, never a client-supplied one.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { authorize, type AuthContext, type OrgRole } from "../authz/policy";
import { appendAudit } from "../audit/service";
import { randomToken, sha256Hex } from "../security/crypto";

export async function createOrganisation(db: Db, ctx: AuthContext, name: string, slug: string) {
  const orgId = randomUUID();
  await db.query(`INSERT INTO organisations (id, name, slug) VALUES ($1, $2, $3)`, [orgId, name, slug]);
  await db.query(
    `INSERT INTO memberships (id, organisation_id, user_id, role) VALUES ($1, $2, $3, 'organisation_owner')`,
    [randomUUID(), orgId, ctx.userId],
  );
  await appendAudit(db, {
    organisationId: orgId, actorType: "user", actorId: ctx.userId,
    action: "organisation.created", resourceType: "organisation", resourceId: orgId, outcome: "success",
  });
  return orgId;
}

export async function createWorkspace(db: Db, ctx: AuthContext, organisationId: string, name: string) {
  await authorize(db, ctx, organisationId, "org:manage");
  const id = randomUUID();
  await db.query(`INSERT INTO workspaces (id, organisation_id, name) VALUES ($1, $2, $3)`, [id, organisationId, name]);
  await appendAudit(db, {
    organisationId, actorType: "user", actorId: ctx.userId,
    action: "workspace.created", resourceType: "workspace", resourceId: id, outcome: "success",
  });
  return id;
}

/** Creates the project plus its sandbox and production environments. */
export async function createProject(db: Db, ctx: AuthContext, organisationId: string, workspaceId: string, name: string) {
  await authorize(db, ctx, organisationId, "projects:create");
  const ws = await db.query(
    `SELECT 1 FROM workspaces WHERE id = $1 AND organisation_id = $2`,
    [workspaceId, organisationId],
  );
  if (ws.rows.length === 0) throw new Error("Workspace does not belong to this organisation.");
  const projectId = randomUUID();
  await db.query(
    `INSERT INTO projects (id, workspace_id, organisation_id, name) VALUES ($1, $2, $3, $4)`,
    [projectId, workspaceId, organisationId, name],
  );
  const envs: Record<string, string> = {};
  for (const kind of ["sandbox", "production"] as const) {
    const envId = randomUUID();
    envs[kind] = envId;
    await db.query(`INSERT INTO environments (id, project_id, kind) VALUES ($1, $2, $3)`, [envId, projectId, kind]);
  }
  await appendAudit(db, {
    organisationId, actorType: "user", actorId: ctx.userId,
    action: "project.created", resourceType: "project", resourceId: projectId, outcome: "success",
  });
  return { projectId, environments: envs };
}

/** Tenant-scoped read — the isolation tests exercise this path. */
export async function listProjects(db: Db, ctx: AuthContext, organisationId: string) {
  await authorize(db, ctx, organisationId, "projects:read");
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.workspace_id, p.created_at FROM projects p WHERE p.organisation_id = $1 ORDER BY p.created_at`,
    [organisationId],
  );
  return rows;
}

const INVITE_DAYS = 7;

export async function inviteMember(
  db: Db, ctx: AuthContext, organisationId: string, email: string, role: OrgRole,
): Promise<{ invitationId: string; token: string }> {
  await authorize(db, ctx, organisationId, "members:invite");
  if (role === "organisation_owner") await authorize(db, ctx, organisationId, "org:manage");
  const id = randomUUID();
  const token = randomToken();
  await db.query(
    `INSERT INTO invitations (id, organisation_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '${INVITE_DAYS} days')`,
    [id, organisationId, email.toLowerCase(), role, sha256Hex(token), ctx.userId],
  );
  await appendAudit(db, {
    organisationId, actorType: "user", actorId: ctx.userId, action: "member.invited",
    resourceType: "invitation", resourceId: id, outcome: "success", details: { role },
  });
  return { invitationId: id, token };
}

export async function acceptInvitation(db: Db, userId: string, userEmail: string, token: string): Promise<string> {
  const { rows } = await db.query<{ id: string; organisation_id: string; email: string; role: OrgRole }>(
    `SELECT id, organisation_id, email, role FROM invitations
     WHERE token_hash = $1 AND expires_at > now() AND accepted_at IS NULL AND revoked_at IS NULL`,
    [sha256Hex(token)],
  );
  const invite = rows[0];
  if (!invite) throw new Error("Invitation is invalid, expired or revoked.");
  if (invite.email !== userEmail.toLowerCase()) throw new Error("Invitation was issued to a different email.");
  await db.query(
    `INSERT INTO memberships (id, organisation_id, user_id, role) VALUES ($1, $2, $3, $4)`,
    [randomUUID(), invite.organisation_id, userId, invite.role],
  );
  await db.query(`UPDATE invitations SET accepted_at = now() WHERE id = $1`, [invite.id]);
  await appendAudit(db, {
    organisationId: invite.organisation_id, actorType: "user", actorId: userId,
    action: "member.joined", resourceType: "membership", outcome: "success", details: { role: invite.role },
  });
  return invite.organisation_id;
}

export async function removeMember(db: Db, ctx: AuthContext, organisationId: string, memberUserId: string) {
  await authorize(db, ctx, organisationId, "members:manage");
  await db.query(
    `UPDATE memberships SET status = 'removed' WHERE organisation_id = $1 AND user_id = $2`,
    [organisationId, memberUserId],
  );
  await appendAudit(db, {
    organisationId, actorType: "user", actorId: ctx.userId, action: "member.removed",
    resourceType: "membership", resourceId: memberUserId, outcome: "success",
  });
}
