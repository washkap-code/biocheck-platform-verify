/**
 * Data minimisation and abuse controls: redacting structured logger, upload
 * validation (size + MIME magic bytes), malware-scan adapter, sliding-window
 * rate limiter with a Redis-compatible abstraction seam.
 */

/* ------------------------- safe structured logging ------------------------- */

const REDACT_KEY = /(image|selfie|embedding|biometric|template|password|secret|token|api_key|apikey|authorization|cookie|id_number|national_id|passport|imageb64|image_b64)/i;
const LONG_BLOB = /[A-Za-z0-9+/_-]{256,}={0,2}/g;

/** Deep-redacts unsafe keys and blob-like values. Returns a NEW object. */
export function redact<T>(value: T): T {
  if (typeof value === "string") return value.replace(LONG_BLOB, "[REDACTED_BLOB]") as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY.test(k) ? "[REDACTED]" : redact(v);
    }
    return out as T;
  }
  return value;
}

export interface LogSink { write(line: string): void }

/** Structured logger that is redacted BY DEFAULT — there is no unredacted mode. */
export function createSafeLogger(sink: LogSink = { write: (l) => console.log(l) }) {
  const emit = (level: string, message: string, context: Record<string, unknown> = {}) => {
    sink.write(JSON.stringify({
      at: new Date().toISOString(), level, message: redact(message), ...redact(context),
    }));
  };
  return {
    info: (msg: string, ctx?: Record<string, unknown>) => emit("info", msg, ctx),
    warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", msg, ctx),
    error: (msg: string, ctx?: Record<string, unknown>) => emit("error", msg, ctx),
  };
}

/* ------------------------- upload validation ------------------------- */

export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

const MAGIC: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/webp": [0x52, 0x49, 0x46, 0x46], // RIFF (WEBP checked at offset 8)
};

/** Validates size and REAL content type from magic bytes — extension/headers are never trusted. */
export function validateCaptureUpload(bytes: Uint8Array): { ok: true; mime: string } | { ok: false; reason: string } {
  if (bytes.byteLength === 0) return { ok: false, reason: "EMPTY_UPLOAD" };
  if (bytes.byteLength > MAX_CAPTURE_BYTES) return { ok: false, reason: "UPLOAD_TOO_LARGE" };
  for (const [mime, magic] of Object.entries(MAGIC)) {
    if (magic.every((b, i) => bytes[i] === b)) {
      if (mime === "image/webp" && !(bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)) continue;
      return { ok: true, mime };
    }
  }
  return { ok: false, reason: "UNSUPPORTED_MEDIA_TYPE" };
}

/* ------------------------- malware scan adapter ------------------------- */

export interface MalwareScanAdapter {
  readonly scannerId: string;
  scan(bytes: Uint8Array): Promise<{ clean: boolean; signature?: string }>;
}

/** Pass-through for development. Production wires a real engine (e.g. ClamAV sidecar). */
export class NoopMalwareScanner implements MalwareScanAdapter {
  readonly scannerId = "noop-dev-only";
  async scan(_bytes: Uint8Array): Promise<{ clean: boolean }> {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Production requires a real malware-scan adapter, not the noop scanner.");
    }
    return { clean: true };
  }
}

/* ------------------------- rate limiting ------------------------- */

export interface RateLimitStore {
  /** Returns the number of hits in the current window after incrementing. */
  hit(bucket: string, windowMs: number): Promise<number>;
}

/** In-process store for dev/tests; production swaps in a Redis-backed store. */
export class MemoryRateLimitStore implements RateLimitStore {
  private hits = new Map<string, number[]>();
  async hit(bucket: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const list = (this.hits.get(bucket) ?? []).filter((t) => now - t < windowMs);
    list.push(now);
    this.hits.set(bucket, list);
    return list.length;
  }
}

export class RateLimitExceededError extends Error {
  readonly status = 429;
}

export interface RateRule { limit: number; windowMs: number }

export const RATE_RULES: Record<string, RateRule> = {
  "auth.login": { limit: 10, windowMs: 60_000 },
  "v1.capture-sessions": { limit: 60, windowMs: 60_000 },
  "v1.verifications": { limit: 120, windowMs: 60_000 },
  "v1.enrolments": { limit: 30, windowMs: 60_000 },
};

export async function enforceRateLimit(store: RateLimitStore, rule: string, actorKey: string): Promise<void> {
  const config = RATE_RULES[rule];
  if (!config) return;
  const count = await store.hit(`${rule}:${actorKey}`, config.windowMs);
  if (count > config.limit) {
    throw new RateLimitExceededError(`Rate limit exceeded for ${rule}. Try again shortly.`);
  }
}

/** Simple velocity anomaly signal: same actor tripping multiple limits. */
export async function isAbusive(store: RateLimitStore, actorKey: string): Promise<boolean> {
  const strikes = await store.hit(`abuse:${actorKey}`, 10 * 60_000);
  return strikes > 5;
}
