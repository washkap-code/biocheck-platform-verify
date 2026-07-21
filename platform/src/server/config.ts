/**
 * Environment configuration — validated at startup with zod.
 * Four environments: development, test, staging, production.
 * Production/staging REFUSE to boot with: missing DATABASE_URL, PGlite,
 * missing IP salt, non-HTTPS verify-core, the fake provider, or a dev KMS.
 * Secrets come only from the environment; nothing is committed.
 */
import { z } from "zod";

export const APP_ENVS = ["development", "test", "staging", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const baseSchema = z.object({
  APP_ENV: z.enum(APP_ENVS).default("development"),
  DATABASE_URL: z.string().url().startsWith("postgres").optional(),
  DB_DRIVER: z.enum(["postgres", "pglite"]).optional(),
  IP_HASH_SALT: z.string().min(16).optional(),
  VERIFY_CORE_URL: z.string().url().optional(),
  VERIFY_CORE_API_KEY: z.string().min(16).optional(),
  REDIS_URL: z.string().url().optional(),
  OBJECT_STORE_URL: z.string().url().optional(),
  BIOCHECK_MASTER_KEY_B64: z.string().optional(),
  BIOCHECK_KMS_PROVIDER: z.enum(["local", "aws"]).optional(),
  BIOCHECK_KMS_KEY_ID: z.string().optional(),
});

export type AppConfig = z.infer<typeof baseSchema> & { appEnv: AppEnv };

export class ConfigError extends Error {}

export function validateConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = baseSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const config = parsed.data;
  const appEnv = config.APP_ENV;
  const hardened = appEnv === "production" || appEnv === "staging";

  const refuse = (why: string) => {
    throw new ConfigError(`${appEnv} refuses to start: ${why}`);
  };

  if (hardened) {
    if (!config.DATABASE_URL) refuse("DATABASE_URL is required.");
    if (config.DB_DRIVER === "pglite") refuse("PGlite is a development database.");
    if (!config.IP_HASH_SALT) refuse("IP_HASH_SALT is required for privacy-minimised IP handling.");
    if (!config.VERIFY_CORE_URL) refuse("VERIFY_CORE_URL is required (the fake provider is not permitted).");
    if (config.VERIFY_CORE_URL && !config.VERIFY_CORE_URL.startsWith("https://")) {
      refuse("VERIFY_CORE_URL must be HTTPS (mTLS terminates at the private gateway).");
    }
    if (!config.VERIFY_CORE_API_KEY) refuse("VERIFY_CORE_API_KEY is required.");
    if (!config.REDIS_URL) refuse("REDIS_URL is required for rate limiting and the job queue.");
    // Master key must come from a KMS adapter, not an env var, in production.
    if (appEnv === "production" && config.BIOCHECK_MASTER_KEY_B64) {
      refuse("BIOCHECK_MASTER_KEY_B64 must not be set in production; configure the KMS/HSM adapter.");
    }
    // Production must be wired to a real per-tenant KMS provider, not the local dev adapter.
    if (appEnv === "production") {
      const kmsProvider = config.BIOCHECK_KMS_PROVIDER ?? "local";
      if (kmsProvider !== "aws") {
        refuse("BIOCHECK_KMS_PROVIDER must be set to a real provider ('aws') in production; the local adapter is dev/staging only.");
      }
      if (kmsProvider === "aws" && !config.BIOCHECK_KMS_KEY_ID) {
        refuse("BIOCHECK_KMS_KEY_ID is required when BIOCHECK_KMS_PROVIDER=aws.");
      }
    }
  } else {
    if (!config.DATABASE_URL && config.DB_DRIVER !== "pglite") {
      refuse("set DATABASE_URL or DB_DRIVER=pglite for local development.");
    }
  }
  return { ...config, appEnv };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cached) cached = validateConfig();
  return cached;
}

/** test hook */
export function resetConfigCache(): void {
  cached = null;
}
