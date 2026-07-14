/**
 * Worker entrypoint (compose `worker` service): validates config, runs
 * migrations, then loops: ensure recurring jobs → run due jobs. Graceful
 * shutdown on SIGTERM. Logs are redacted by default via createSafeLogger.
 */
import { validateConfig } from "../config";
import { createPostgresDb, createPgliteDb } from "../db/client";
import { migrate } from "../db/migrate";
import { buildRegistry, ensureRecurringJobs } from "./maintenance";
import { runDueJobs } from "./framework";
import { MemoryStorageAdapter } from "../privacy/evidence";
import { createSafeLogger } from "../security/controls";

const logger = createSafeLogger();

async function main() {
  const config = validateConfig();
  const db = config.DATABASE_URL ? await createPostgresDb(config.DATABASE_URL) : await createPgliteDb();
  await migrate(db);
  // Storage: S3-compatible adapter in staging/production (wired via OBJECT_STORE_URL);
  // in-memory for local development.
  const registry = buildRegistry({ storage: new MemoryStorageAdapter() });

  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });

  logger.info("worker started", { appEnv: config.appEnv });
  while (!stopping) {
    try {
      await ensureRecurringJobs(db);
      const result = await runDueJobs(db, registry);
      if (result.ran > 0) logger.info("jobs processed", { ...result });
      if (result.dead > 0) logger.error("jobs dead-lettered", { dead: result.dead });
    } catch (err) {
      logger.error("worker tick failed", { message: err instanceof Error ? err.message : "unknown" });
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  await db.close();
  logger.info("worker stopped");
}

main().catch((err) => {
  logger.error("worker fatal", { message: err instanceof Error ? err.message : "unknown" });
  process.exit(1);
});
