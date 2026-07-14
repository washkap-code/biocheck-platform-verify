/**
 * Biometric provider contract.
 *
 * The platform NEVER sees plaintext embeddings. analyseCapture returns an
 * opaque short-lived captureRef; createTemplate returns opaque ciphertext;
 * compareTemplates returns only a similarity score. The real implementation
 * delegates to verify-core (Python biocheck_engine) in front of the private
 * SeetaFace6 sidecar; the deterministic fake exists for automated tests and
 * local seed data ONLY and must never be selectable in production config.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { sha256Hex } from "../security/crypto";
import type { Db } from "../db/client";

export interface CaptureQuality {
  faceDetected: boolean;
  qualityScore: number;
  poseDegrees: number;
  occlusionScore: number;
}

export interface LivenessSignal {
  isLive: boolean;
  score: number;
  attackType: string | null;
}

export interface CaptureAnalysis {
  captureRef: string;         // opaque, single verification only
  quality: CaptureQuality;
  liveness: LivenessSignal;
  modelId: string;
  modelSha256: string;
  padModelId: string;
  padModelSha256: string;
}

export interface TemplateResult {
  templateCiphertext: string; // opaque to the platform
  modelId: string;
  modelSha256: string;
}

export interface BiometricProvider {
  readonly providerId: string;
  analyseCapture(imageBytes: Uint8Array, challengeNonce: string): Promise<CaptureAnalysis>;
  createTemplate(captureRef: string): Promise<TemplateResult>;
  compareTemplates(templateCiphertext: string, captureRef: string): Promise<{ similarity: number }>;
}

export class ProviderUnavailableError extends Error {
  readonly code = "SERVICE_UNAVAILABLE";
}
export class ModelNotApprovedError extends Error {
  readonly code = "MODEL_NOT_APPROVED";
}

/** Persistent approved-model gate. Unknown/changed models are NOT errors the
 *  caller may ignore — the verification service maps them to REVIEW. */
export async function assertModelApproved(db: Db, modelId: string, sha256: string, purpose: string): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM model_registry
     WHERE model_id = $1 AND sha256 = $2 AND purpose = $3
       AND status = 'active' AND commercial_use_approved AND expires_on >= CURRENT_DATE`,
    [modelId, sha256, purpose],
  );
  if (rows.length === 0) {
    throw new ModelNotApprovedError(`Model '${modelId}' (${purpose}) is not in the approved registry.`);
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic fake provider — automated tests and seed demo ONLY.   */
/* ------------------------------------------------------------------ */

export const FAKE_MODEL = { id: "fake-embedding-v1", sha256: "f".repeat(64) };
export const FAKE_PAD_MODEL = { id: "fake-pad-v1", sha256: "e".repeat(64) };

interface FakeFixture {
  person: string;
  quality?: number;
  pose?: number;
  occlusion?: number;
  faceDetected?: boolean;
  live?: boolean;
  livenessScore?: number;
  attackType?: string | null;
}

const DEV_KEY = Buffer.alloc(32, 7); // clearly-labelled local test key, not a secret

function encryptOpaque(payload: object): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", DEV_KEY, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
}

function decryptOpaque(blob: string): { person: string } {
  const raw = Buffer.from(blob, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", DEV_KEY, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString());
}

/**
 * Test fixtures are JSON documents pretending to be images, e.g.
 * {"person":"alice","quality":0.98,"live":true}. Same person ⇒ similarity 0.99;
 * different people ⇒ 0.12. Deterministic and biometric-free.
 */
export class FakeProvider implements BiometricProvider {
  readonly providerId = "fake-deterministic";
  private captures = new Map<string, FakeFixture>();

  constructor() {
    if (process.env.NODE_ENV === "production") {
      throw new Error("FakeProvider must never be instantiated in production.");
    }
  }

  async analyseCapture(imageBytes: Uint8Array, challengeNonce: string): Promise<CaptureAnalysis> {
    if (!challengeNonce) throw new Error("challengeNonce is required");
    let fixture: FakeFixture;
    try {
      fixture = JSON.parse(Buffer.from(imageBytes).toString("utf8"));
    } catch {
      fixture = { person: sha256Hex(imageBytes).slice(0, 12) };
    }
    const captureRef = `fakecap_${randomUUID()}`;
    this.captures.set(captureRef, fixture);
    return {
      captureRef,
      quality: {
        faceDetected: fixture.faceDetected ?? true,
        qualityScore: fixture.quality ?? 0.97,
        poseDegrees: fixture.pose ?? 2,
        occlusionScore: fixture.occlusion ?? 0.02,
      },
      liveness: {
        isLive: fixture.live ?? true,
        score: fixture.livenessScore ?? (fixture.live === false ? 0.1 : 0.99),
        attackType: fixture.attackType ?? null,
      },
      modelId: FAKE_MODEL.id,
      modelSha256: FAKE_MODEL.sha256,
      padModelId: FAKE_PAD_MODEL.id,
      padModelSha256: FAKE_PAD_MODEL.sha256,
    };
  }

  async createTemplate(captureRef: string): Promise<TemplateResult> {
    const fixture = this.captures.get(captureRef);
    if (!fixture) throw new Error("Unknown or expired captureRef");
    return {
      templateCiphertext: encryptOpaque({ person: fixture.person }),
      modelId: FAKE_MODEL.id,
      modelSha256: FAKE_MODEL.sha256,
    };
  }

  async compareTemplates(templateCiphertext: string, captureRef: string): Promise<{ similarity: number }> {
    const fixture = this.captures.get(captureRef);
    if (!fixture) throw new Error("Unknown or expired captureRef");
    const reference = decryptOpaque(templateCiphertext);
    return { similarity: reference.person === fixture.person ? 0.99 : 0.12 };
  }
}

/* ------------------------------------------------------------------ */
/* verify-core sidecar client — the production path.                   */
/* ------------------------------------------------------------------ */

export interface VerifyCoreConfig {
  endpoint: string;           // private mTLS endpoint of verify-core
  apiKey: string;
  timeoutMs?: number;
  /** injectable for contract tests */
  transport?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * HTTP client for the private verify-core service (Python biocheck_engine +
 * SeetaFace6 sidecar). Fail-closed: any transport error, timeout or malformed
 * response raises ProviderUnavailableError — callers route to REVIEW, never
 * approve. Request bodies are never logged. Production refuses non-HTTPS
 * endpoints (mTLS terminates at the private gateway).
 */
export class VerifyCoreProvider implements BiometricProvider {
  readonly providerId = "verify-core";
  private readonly timeoutMs: number;
  private readonly transport: (url: string, init: RequestInit) => Promise<Response>;

  constructor(private readonly config: VerifyCoreConfig) {
    const url = new URL(config.endpoint);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(isLocal && process.env.NODE_ENV !== "production")) {
      throw new Error("verify-core endpoint must be HTTPS (mTLS) outside local development.");
    }
    this.timeoutMs = config.timeoutMs ?? 8000;
    this.transport = config.transport ?? ((u, init) => fetch(u, init));
  }

  private async post<T>(path: string, body: object): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.transport(`${this.config.endpoint.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
          "X-BioCheck-Data-Classification": "biometric-sensitive",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new ProviderUnavailableError(`verify-core returned ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof ProviderUnavailableError) throw err;
      // No request-body logging — the error carries no capture content.
      throw new ProviderUnavailableError("verify-core unreachable; verification must fail closed.");
    } finally {
      clearTimeout(timer);
    }
  }

  async analyseCapture(imageBytes: Uint8Array, challengeNonce: string): Promise<CaptureAnalysis> {
    if (imageBytes.byteLength === 0 || imageBytes.byteLength > 8 * 1024 * 1024) {
      throw new Error("Capture must be non-empty and below 8 MiB.");
    }
    const data = await this.post<Record<string, unknown>>("/v1/analyse", {
      image_b64: Buffer.from(imageBytes).toString("base64"),
      challenge_id: challengeNonce,
      retain_image: false,
    });
    const q = data.quality as Record<string, unknown> | undefined;
    const pad = data.passive_pad as Record<string, unknown> | undefined;
    if (!data.capture_ref || !q || !pad || !data.model_id || !data.model_sha256) {
      throw new ProviderUnavailableError("verify-core response missing required fields.");
    }
    return {
      captureRef: String(data.capture_ref),
      quality: {
        faceDetected: Boolean(q.face_detected),
        qualityScore: Number(q.score),
        poseDegrees: Number(q.pose_degrees),
        occlusionScore: Number(q.occlusion_score),
      },
      liveness: { isLive: Boolean(pad.is_live), score: Number(pad.score), attackType: (pad.attack_type as string) ?? null },
      modelId: String(data.model_id),
      modelSha256: String(data.model_sha256),
      padModelId: String(pad.model_id),
      padModelSha256: String(pad.model_sha256),
    };
  }

  async createTemplate(captureRef: string): Promise<TemplateResult> {
    const data = await this.post<Record<string, unknown>>("/v1/templates", { capture_ref: captureRef });
    if (!data.template_ciphertext || !data.model_id || !data.model_sha256) {
      throw new ProviderUnavailableError("verify-core template response malformed.");
    }
    return {
      templateCiphertext: String(data.template_ciphertext),
      modelId: String(data.model_id),
      modelSha256: String(data.model_sha256),
    };
  }

  async compareTemplates(templateCiphertext: string, captureRef: string): Promise<{ similarity: number }> {
    const data = await this.post<Record<string, unknown>>("/v1/compare", {
      template_ciphertext: templateCiphertext,
      capture_ref: captureRef,
    });
    const similarity = Number(data.similarity);
    if (!Number.isFinite(similarity)) throw new ProviderUnavailableError("verify-core similarity malformed.");
    return { similarity };
  }
}
