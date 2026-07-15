/**
 * POST /api/demo-requests — public marketing lead capture (Phase 6).
 * Unauthenticated by design, so defended in depth: strict validation in the
 * service, sliding-window rate limit on a salted IP hash, and a honeypot
 * field. Never logs request bodies.
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/server/runtime";
import { createDemoRequest, LeadValidationError } from "@/server/leads/service";
import {
  MemoryRateLimitStore, RateLimitExceededError, RATE_RULES, enforceRateLimit,
} from "@/server/security/controls";
import { minimiseIp } from "@/server/security/crypto";

export const dynamic = "force-dynamic";

RATE_RULES["public.demo-requests"] = { limit: 5, windowMs: 60_000 };
// In-process store: same Redis-ready seam as the rest of the platform.
const store = new MemoryRateLimitStore();

export async function POST(request: NextRequest) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: { code: "INVALID_JSON", message: "Body must be JSON." } }, { status: 400 });
    }

    // Honeypot: real users never fill this hidden field. Pretend success.
    if (typeof body.website === "string" && body.website.trim() !== "") {
      return NextResponse.json({ ok: true }, { status: 201 });
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const salt = process.env.IP_HASH_SALT ?? "dev-only-salt-not-secret";
    const ipHash = minimiseIp(ip, salt);
    await enforceRateLimit(store, "public.demo-requests", ipHash ?? "unknown");

    const db = await getDb();
    const { id } = await createDemoRequest(db, {
      fullName: String(body.fullName ?? ""),
      workEmail: String(body.workEmail ?? ""),
      organisation: String(body.organisation ?? ""),
      sector: String(body.sector ?? ""),
      country: typeof body.country === "string" ? body.country : undefined,
      message: typeof body.message === "string" ? body.message : undefined,
      consentedToContact: body.consentedToContact === true,
      sourcePath: typeof body.sourcePath === "string" ? body.sourcePath : undefined,
      ipHash,
    });
    return NextResponse.json({ ok: true, id }, { status: 201 });
  } catch (err) {
    if (err instanceof LeadValidationError) {
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
    }
    if (err instanceof RateLimitExceededError) {
      return NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again shortly." } },
        { status: 429 },
      );
    }
    console.error("demo-requests unhandled error:", err instanceof Error ? err.message : "unknown");
    return NextResponse.json({ error: { code: "INTERNAL", message: "Unexpected error." } }, { status: 500 });
  }
}
