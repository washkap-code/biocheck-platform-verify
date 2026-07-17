/**
 * Verify Lab control endpoint (console-internal).
 *
 * The lab lets a signed-in console user exercise the REAL enrol/verify
 * pipeline (capture sessions, providers, policy, audit) using a tenant API
 * key they supply. The key is held in an HttpOnly cookie scoped to the lab
 * endpoints — it is never exposed to client-side JavaScript.
 *
 * Guard rails:
 *  - console session required (the lab UI is not public);
 *  - the API key is re-authenticated on every call (revocation applies
 *    immediately);
 *  - production-kind environments are refused: the lab is a testing tool,
 *    not an operational channel;
 *  - audit attribution is the API key, exactly as with direct /v1 calls.
 *
 * Actions: {action:"configure", apiKey} | {action:"reset"} |
 *          {action:"session", purpose, modality}
 * Capture submissions go to ./submit (separate route, flow-compatible body).
 */
import { NextRequest, NextResponse } from "next/server";
import { getAuthContext, getDb } from "@/server/runtime";
import { authenticateApiKey } from "@/server/apikeys/service";
import { errorResponse } from "@/server/api/http";
import { createCaptureSession, VerificationError } from "@/server/verification/service";

export const dynamic = "force-dynamic";

export const LAB_COOKIE = "biocheck_vl_key";
const COOKIE_PATH = "/api/console/verify-lab";
const COOKIE_MAX_AGE_S = 2 * 60 * 60;

export async function POST(request: NextRequest) {
  try {
    const ctx = await getAuthContext();
    if (!ctx) {
      return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Sign in to the console first." } }, { status: 401 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const db = await getDb();

    if (body.action === "configure") {
      if (typeof body.apiKey !== "string" || !body.apiKey) {
        throw new VerificationError("Provide the project API key to use for lab calls.", "INVALID_REQUEST");
      }
      const principal = await authenticateApiKey(db, body.apiKey, "verification:create");
      if (principal.environmentKind === "production") {
        return NextResponse.json({
          error: { code: "PRODUCTION_KEY_REFUSED",
                   message: "The Verify Lab refuses production environment keys. Use a development or staging key." },
        }, { status: 403 });
      }
      const res = NextResponse.json({ ok: true, environmentKind: principal.environmentKind, projectId: principal.projectId });
      res.cookies.set(LAB_COOKIE, body.apiKey, {
        httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
        path: COOKIE_PATH, maxAge: COOKIE_MAX_AGE_S,
      });
      return res;
    }

    if (body.action === "reset") {
      const res = NextResponse.json({ ok: true });
      res.cookies.set(LAB_COOKIE, "", { httpOnly: true, sameSite: "strict", path: COOKIE_PATH, maxAge: 0 });
      return res;
    }

    if (body.action === "session") {
      const apiKey = request.cookies.get(LAB_COOKIE)?.value;
      if (!apiKey) {
        return NextResponse.json({ error: { code: "LAB_NOT_CONFIGURED", message: "Configure a lab API key first." } }, { status: 401 });
      }
      const principal = await authenticateApiKey(db, apiKey, "verification:create");
      if (principal.environmentKind === "production") {
        return NextResponse.json({ error: { code: "PRODUCTION_KEY_REFUSED", message: "Production keys are refused." } }, { status: 403 });
      }
      const purpose = body.purpose === "enrolment" ? "enrolment" : body.purpose === "verification" ? "verification" : null;
      if (!purpose) throw new VerificationError("purpose must be 'enrolment' or 'verification'.", "INVALID_PURPOSE");
      const modality = body.modality === "fingerprint" ? "fingerprint" : body.modality === "face" ? "face" : null;
      if (!modality) throw new VerificationError("modality must be 'face' or 'fingerprint'.", "INVALID_MODALITY");
      const session = await createCaptureSession(db, principal, purpose, undefined, modality);
      return NextResponse.json({ clientToken: session.clientToken, challenge: session.challenge, expiresAt: session.expiresAt }, { status: 201 });
    }

    throw new VerificationError("Unknown action.", "INVALID_REQUEST");
  } catch (err) {
    return errorResponse(err);
  }
}
