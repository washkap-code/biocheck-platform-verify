/**
 * Shared /v1 route plumbing: API-key auth, error → HTTP mapping, idempotency.
 * Route files stay thin adapters; business rules live in the services.
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../runtime";
import { authenticateApiKey, type ApiKeyPrincipal, type ApiScope } from "../apikeys/service";
import { AuthorizationError } from "../authz/policy";
import { VerificationError } from "../verification/service";
import { IdempotencyConflictError, withIdempotency } from "../idempotency";
import { FakeProvider, VerifyCoreProvider, type BiometricProvider } from "../verification/providers";

let provider: BiometricProvider | null = null;

/** Provider selection is explicit config, never a silent fallback. */
export function getProvider(): BiometricProvider {
  if (provider) return provider;
  if (process.env.VERIFY_CORE_URL && process.env.VERIFY_CORE_API_KEY) {
    provider = new VerifyCoreProvider({ endpoint: process.env.VERIFY_CORE_URL, apiKey: process.env.VERIFY_CORE_API_KEY });
  } else if (process.env.NODE_ENV !== "production" && process.env.DB_DRIVER === "pglite") {
    provider = new FakeProvider(); // local development against the deterministic fake
  } else {
    throw new Error("Configure VERIFY_CORE_URL and VERIFY_CORE_API_KEY (see .env.example).");
  }
  return provider;
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AuthorizationError) {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: err.message } }, { status: 403 });
  }
  if (err instanceof VerificationError) {
    return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  if (err instanceof IdempotencyConflictError) {
    return NextResponse.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: err.message } }, { status: 422 });
  }
  // Never echo internals or request content back to the caller.
  console.error("v1 unhandled error:", err instanceof Error ? err.message : "unknown");
  return NextResponse.json({ error: { code: "INTERNAL", message: "Unexpected error." } }, { status: 500 });
}

export async function withApiKey(
  request: NextRequest, scope: ApiScope,
  handler: (principal: ApiKeyPrincipal, body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>,
): Promise<NextResponse> {
  try {
    const auth = request.headers.get("authorization") ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!presented) {
      return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Provide an API key as a Bearer token." } }, { status: 401 });
    }
    const db = await getDb();
    const principal = await authenticateApiKey(db, presented, scope);
    let body: Record<string, unknown> = {};
    if (request.method === "POST") {
      try { body = (await request.json()) as Record<string, unknown>; } catch { body = {}; }
    }
    const idemKey = request.headers.get("idempotency-key");
    const endpoint = new URL(request.url).pathname;
    const result = await withIdempotency(db, principal.apiKeyId, endpoint, request.method === "POST" ? idemKey : null, body,
      () => handler(principal, body));
    return NextResponse.json(result.body, { status: result.status, headers: result.replayed ? { "Idempotency-Replayed": "true" } : undefined });
  } catch (err) {
    return errorResponse(err);
  }
}
