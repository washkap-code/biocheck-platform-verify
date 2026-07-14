/**
 * THE single permission layer. Every privileged operation calls authorize().
 * No role checks may appear in components, routes or other services.
 * Membership is always resolved server-side — a client-provided organisation
 * ID is never trusted without a membership row lookup.
 */
import type { Db } from "../db/client";

export type OrgRole =
  | "organisation_owner"
  | "organisation_admin"
  | "compliance_officer"
  | "integration_developer"
  | "reviewer"
  | "analyst"
  | "read_only";

export type PlatformRole = "platform_super_admin" | "platform_security_admin";

export type Permission =
  | "org:manage"
  | "org:read"
  | "members:invite"
  | "members:manage"
  | "projects:create"
  | "projects:read"
  | "apikeys:create"
  | "apikeys:read"
  | "apikeys:revoke"
  | "audit:read"
  | "audit:export"
  | "reviews:decide"
  | "policies:approve"
  | "sso:configure";

const ORG_ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  organisation_owner: [
    "org:manage", "org:read", "members:invite", "members:manage", "projects:create",
    "projects:read", "apikeys:create", "apikeys:read", "apikeys:revoke",
    "audit:read", "audit:export", "policies:approve", "sso:configure",
  ],
  organisation_admin: [
    "org:read", "members:invite", "members:manage", "projects:create", "projects:read",
    "apikeys:create", "apikeys:read", "apikeys:revoke", "audit:read", "audit:export",
  ],
  compliance_officer: ["org:read", "projects:read", "audit:read", "audit:export", "policies:approve"],
  integration_developer: ["org:read", "projects:read", "apikeys:create", "apikeys:read"],
  reviewer: ["org:read", "projects:read", "reviews:decide"],
  analyst: ["org:read", "projects:read", "audit:read"],
  read_only: ["org:read", "projects:read"],
};

/** Roles that must have TOTP MFA enabled before a session is issued. */
export const MFA_REQUIRED_ROLES: ReadonlySet<string> = new Set([
  "platform_super_admin", "platform_security_admin", "organisation_owner", "organisation_admin",
]);

export interface AuthContext {
  userId: string;
  platformRole: PlatformRole | null;
}

export class AuthorizationError extends Error {
  readonly code = "FORBIDDEN";
  constructor(message: string) {
    super(message);
  }
}

export interface Grant {
  organisationId: string;
  role: OrgRole | PlatformRole;
  permission: Permission;
}

/**
 * Resolves the caller's ACTIVE membership of the organisation and asserts the
 * permission. Platform roles have read/security oversight, not silent tenant
 * write access: platform_super_admin passes all checks (fully audited);
 * platform_security_admin passes only read/audit permissions.
 */
export async function authorize(
  db: Db,
  ctx: AuthContext,
  organisationId: string,
  permission: Permission,
): Promise<Grant> {
  if (ctx.platformRole === "platform_super_admin") {
    return { organisationId, role: ctx.platformRole, permission };
  }
  if (
    ctx.platformRole === "platform_security_admin" &&
    (permission === "audit:read" || permission === "audit:export" || permission === "org:read" || permission === "projects:read")
  ) {
    return { organisationId, role: ctx.platformRole, permission };
  }
  const { rows } = await db.query<{ role: OrgRole }>(
    `SELECT role FROM memberships WHERE organisation_id = $1 AND user_id = $2 AND status = 'active'`,
    [organisationId, ctx.userId],
  );
  if (rows.length === 0) throw new AuthorizationError("Not a member of this organisation.");
  const role = rows[0].role;
  if (!ORG_ROLE_PERMISSIONS[role]?.includes(permission)) {
    throw new AuthorizationError(`Role '${role}' does not grant '${permission}'.`);
  }
  return { organisationId, role, permission };
}

/** Asserts that a project belongs to the organisation the caller was authorised for. */
export async function assertProjectInOrg(db: Db, projectId: string, organisationId: string): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM projects WHERE id = $1 AND organisation_id = $2`,
    [projectId, organisationId],
  );
  if (rows.length === 0) throw new AuthorizationError("Project does not belong to this organisation.");
}
