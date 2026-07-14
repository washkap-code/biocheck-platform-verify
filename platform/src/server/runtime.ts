/**
 * Runtime wiring for the Next.js app: one Db instance per process and
 * cookie-session resolution. Production requires DATABASE_URL; local
 * development may use PGlite explicitly via DB_DRIVER=pglite (never silently).
 */
import { cookies } from "next/headers";
import { createPgliteDb, createPostgresDb, type Db } from "./db/client";
import { migrate } from "./db/migrate";
import { resolveSession } from "./auth/service";
import type { AuthContext, PlatformRole } from "./authz/policy";

let dbPromise: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const driver = process.env.DB_DRIVER ?? (process.env.DATABASE_URL ? "postgres" : "");
      let db: Db;
      if (driver === "postgres") {
        db = await createPostgresDb(process.env.DATABASE_URL!);
      } else if (driver === "pglite" && process.env.NODE_ENV !== "production") {
        db = await createPgliteDb(); // dev-only, clearly opted into
      } else {
        throw new Error("Set DATABASE_URL (production) or DB_DRIVER=pglite (development only). See .env.example.");
      }
      await migrate(db);
      return db;
    })();
  }
  return dbPromise;
}

export const SESSION_COOKIE = "biocheck_session";

/** Resolves the signed-in user from the session cookie, or null. */
export async function getAuthContext(): Promise<AuthContext | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const session = await resolveSession(db, token);
  if (!session) return null;
  const { rows } = await db.query<{ platform_role: PlatformRole | null }>(
    `SELECT platform_role FROM users WHERE id = $1 AND status = 'active'`,
    [session.userId],
  );
  if (rows.length === 0) return null;
  return { userId: session.userId, platformRole: rows[0].platform_role };
}
