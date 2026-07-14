/**
 * Authentication and enterprise account controls.
 * Sessions are opaque random tokens stored only as SHA-256 hashes, rotated on
 * every privilege-relevant event. Lockout applies after repeated failures.
 * Privileged roles cannot obtain a session without TOTP MFA.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { hashPassword, verifyPassword, randomToken, sha256Hex, minimiseIp } from "../security/crypto";
import { verifyTotp, generateTotpSecret } from "./totp";
import { MFA_REQUIRED_ROLES } from "../authz/policy";
import { appendAudit } from "../audit/service";
import { encryptSecret, decryptSecret } from "../security/secrets";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const SESSION_HOURS = 12;
const COMMON_PASSWORDS = new Set(["password1234", "biocheck2026!", "letmein12345"]);

export class AuthError extends Error {
  constructor(message: string, readonly code:
    | "INVALID_CREDENTIALS" | "LOCKED" | "EMAIL_UNVERIFIED" | "MFA_REQUIRED"
    | "MFA_INVALID" | "WEAK_PASSWORD" | "SESSION_INVALID") {
    super(message);
  }
}

export function assertPasswordPolicy(password: string, email: string): void {
  if (password.length < 12) throw new AuthError("Password must be at least 12 characters.", "WEAK_PASSWORD");
  if (COMMON_PASSWORDS.has(password.toLowerCase())) throw new AuthError("Password is too common.", "WEAK_PASSWORD");
  if (email && password.toLowerCase().includes(email.split("@")[0].toLowerCase())) {
    throw new AuthError("Password must not contain your email name.", "WEAK_PASSWORD");
  }
}

export interface RegisteredUser { userId: string; emailVerificationToken: string }

export async function registerUser(db: Db, email: string, password: string): Promise<RegisteredUser> {
  assertPasswordPolicy(password, email);
  const userId = randomUUID();
  await db.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
    [userId, email.toLowerCase(), hashPassword(password)],
  );
  const token = randomToken();
  // Verification token stored hashed on a session-style row with short expiry.
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 day')`,
    [randomUUID(), userId, `email-verify:${sha256Hex(token)}`],
  );
  await appendAudit(db, {
    organisationId: null, actorType: "user", actorId: userId,
    action: "user.registered", resourceType: "user", resourceId: userId, outcome: "success",
  });
  return { userId, emailVerificationToken: token };
}

export async function verifyEmail(db: Db, token: string): Promise<void> {
  const hash = `email-verify:${sha256Hex(token)}`;
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now() AND revoked_at IS NULL`,
    [hash],
  );
  if (rows.length === 0) throw new AuthError("Invalid or expired verification token.", "SESSION_INVALID");
  await db.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [rows[0].user_id]);
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1`, [hash]);
}

interface UserRow {
  id: string; email: string; password_hash: string; email_verified_at: string | null;
  failed_attempts: number; locked_until: string | null; mfa_enabled: boolean;
  totp_secret_enc: string | null; platform_role: string | null; status: string;
}

export interface LoginResult { userId: string; sessionToken: string; sessionId: string }

export async function login(
  db: Db,
  email: string,
  password: string,
  opts: { totpCode?: string; ip?: string; ipSalt?: string; userAgent?: string } = {},
): Promise<LoginResult> {
  const { rows } = await db.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
  const user = rows[0];
  const fail = async (code: "INVALID_CREDENTIALS" | "LOCKED" | "EMAIL_UNVERIFIED" | "MFA_REQUIRED" | "MFA_INVALID", msg: string) => {
    if (user) {
      await appendAudit(db, {
        organisationId: null, actorType: "user", actorId: user.id, action: "user.login",
        resourceType: "session", outcome: code === "MFA_REQUIRED" ? "denied" : "failure",
        details: { reason: code }, ipMinimised: minimiseIp(opts.ip, opts.ipSalt ?? "audit"),
      });
    }
    throw new AuthError(msg, code);
  };

  if (!user || user.status !== "active") await fail("INVALID_CREDENTIALS", "Invalid email or password.");
  const u = user!;
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    await fail("LOCKED", "Account temporarily locked after repeated failures.");
  }
  if (!verifyPassword(password, u.password_hash)) {
    const attempts = u.failed_attempts + 1;
    await db.query(
      `UPDATE users SET failed_attempts = $2::int,
         locked_until = CASE WHEN $2::int >= $3::int THEN now() + interval '${LOCKOUT_MINUTES} minutes' ELSE locked_until END
       WHERE id = $1`,
      [u.id, attempts, MAX_FAILED_ATTEMPTS],
    );
    await fail("INVALID_CREDENTIALS", "Invalid email or password.");
  }
  if (!u.email_verified_at) await fail("EMAIL_UNVERIFIED", "Verify your email before signing in.");

  // MFA: mandatory for privileged roles, enforced whenever enrolled.
  const privileged = await isPrivileged(db, u);
  if (u.mfa_enabled && u.totp_secret_enc) {
    if (!opts.totpCode) await fail("MFA_REQUIRED", "TOTP code required.");
    const totpSecret = await decryptSecret(db, null, `totp:${u.id}`, u.totp_secret_enc);
    if (!verifyTotp(totpSecret, opts.totpCode!) && !(await consumeRecoveryCode(db, u.id, opts.totpCode!))) {
      await fail("MFA_INVALID", "Invalid TOTP code.");
    }
  } else if (privileged) {
    await fail("MFA_REQUIRED", "Privileged roles must enrol TOTP MFA before signing in.");
  }

  await db.query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`, [u.id]);
  const token = randomToken();
  const sessionId = randomUUID();
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, ip_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '${SESSION_HOURS} hours')`,
    [sessionId, u.id, sha256Hex(token), minimiseIp(opts.ip, opts.ipSalt ?? "session"), opts.userAgent ?? null],
  );
  await appendAudit(db, {
    organisationId: null, actorType: "user", actorId: u.id, action: "user.login",
    resourceType: "session", resourceId: sessionId, outcome: "success",
    ipMinimised: minimiseIp(opts.ip, opts.ipSalt ?? "audit"),
  });
  return { userId: u.id, sessionToken: token, sessionId };
}

async function isPrivileged(db: Db, user: UserRow): Promise<boolean> {
  if (user.platform_role && MFA_REQUIRED_ROLES.has(user.platform_role)) return true;
  const { rows } = await db.query<{ role: string }>(
    `SELECT role FROM memberships WHERE user_id = $1 AND status = 'active'`,
    [user.id],
  );
  return rows.some((r) => MFA_REQUIRED_ROLES.has(r.role));
}

export async function resolveSession(db: Db, token: string): Promise<{ userId: string; sessionId: string } | null> {
  const { rows } = await db.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM sessions WHERE token_hash = $1 AND expires_at > now() AND revoked_at IS NULL`,
    [sha256Hex(token)],
  );
  return rows[0] ? { userId: rows[0].user_id, sessionId: rows[0].id } : null;
}

/** Rotation: old token is revoked atomically; returns the replacement. */
export async function rotateSession(db: Db, token: string): Promise<string> {
  const current = await resolveSession(db, token);
  if (!current) throw new AuthError("Session is invalid or expired.", "SESSION_INVALID");
  const next = randomToken();
  const nextId = randomUUID();
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, rotated_from, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '${SESSION_HOURS} hours')`,
    [nextId, current.userId, sha256Hex(next), current.sessionId],
  );
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [current.sessionId]);
  return next;
}

export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

export async function listSessions(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT id, created_at, expires_at, revoked_at, user_agent FROM sessions
     WHERE user_id = $1 AND token_hash NOT LIKE 'email-verify:%' ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

export async function enrolTotp(db: Db, userId: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  const secret = generateTotpSecret();
  const secretEnc = await encryptSecret(db, null, `totp:${userId}`, secret);
  await db.query(`UPDATE users SET totp_secret_enc = $2, mfa_enabled = TRUE WHERE id = $1`, [userId, secretEnc]);
  const codes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const code = randomToken(6);
    codes.push(code);
    await db.query(
      `INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)`,
      [randomUUID(), userId, sha256Hex(code)],
    );
  }
  return { secret, recoveryCodes: codes };
}

async function consumeRecoveryCode(db: Db, userId: string, code: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, sha256Hex(code)],
  );
  if (!rows[0]) return false;
  await db.query(`UPDATE recovery_codes SET used_at = now() WHERE id = $1`, [rows[0].id]);
  return true;
}
