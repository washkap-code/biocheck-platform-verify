/**
 * Database access. Tests and local development use PGlite (real Postgres
 * semantics, in-process). Production uses node-postgres via DATABASE_URL.
 * Both expose the same minimal query interface used by the services.
 */
export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  /** Multi-statement execution (migrations only — never user input). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  /**
   * Runs fn against a single dedicated connection wrapped in BEGIN/COMMIT
   * (ROLLBACK on throw). Required whenever a caller needs multiple
   * statements — e.g. an advisory lock plus the read/write it guards — to
   * observe a consistent, serialised view: a plain pool `query()` per
   * statement may hop connections and silently lose that guarantee.
   */
  withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export async function createPgliteDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();

  const makeDb = (runner: { query: typeof pg.query }): Db => ({
    async query<R>(sql: string, params: unknown[] = []) {
      const res = await runner.query(sql, params);
      return { rows: res.rows as R[] };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async close() {
      await pg.close();
    },
    async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // PGlite is a single in-process instance (no connection pool), so
      // sequential BEGIN/COMMIT on it already gives one consistent session.
      await pg.query("BEGIN");
      try {
        const result = await fn(makeDb(runner));
        await pg.query("COMMIT");
        return result;
      } catch (err) {
        await pg.query("ROLLBACK");
        throw err;
      }
    },
  });

  return makeDb(pg);
}

export async function createPostgresDb(databaseUrl: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl });

  const makeDb = (runner: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Db => ({
    async query<R>(sql: string, params: unknown[] = []) {
      const res = await runner.query(sql, params);
      return { rows: res.rows as R[] };
    },
    async exec(sql: string) {
      await runner.query(sql);
    },
    async close() {
      await pool.end();
    },
    async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // A dedicated client for the lifetime of the transaction — this is
      // what makes an advisory xact lock actually guard the statements that
      // follow it, instead of each statement landing on a different pooled
      // connection.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        try {
          const result = await fn(makeDb(client));
          await client.query("COMMIT");
          return result;
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      } finally {
        client.release();
      }
    },
  });

  return makeDb(pool);
}
