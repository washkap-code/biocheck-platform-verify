/**
 * Verify Lab capture submission — flow-compatible body, same shape the
 * CaptureFlow/FingerprintFlow components post:
 * {modality?, purpose, subjectRef, captureSessionToken, imageB64, noticeVersion}
 *
 * Calls the same service functions as the public /v1 routes with the
 * principal authenticated from the lab cookie, so behaviour, policy, audit
 * and fail-closed semantics are identical to production API traffic.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAuthContext, getDb } from "@/server/runtime";
import { authenticateApiKey } from "@/server/apikeys/service";
import { errorResponse, getFingerprintProvider, getProvider } from "@/server/api/http";
import {
  enrolFingerprint, enrolSubject, verifyFingerprint, verifySubject, VerificationError,
} from "@/server/verification/service";
import { LAB_COOKIE } from "@/server/console/labCookie";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const ctx = await getAuthContext();
    if (!ctx) {
      return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Sign in to the console first." } }, { status: 401 });
    }
    const apiKey = request.cookies.get(LAB_COOKIE)?.value;
    if (!apiKey) {
      return NextResponse.json({ error: { code: "LAB_NOT_CONFIGURED", message: "Configure a lab API key first." } }, { status: 401 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const db = await getDb();

    const purpose = body.purpose === "enrolment" ? "enrolment" : "verification";
    const scope = purpose === "enrolment" ? "enrolment:create" : "verification:create";
    const principal = await authenticateApiKey(db, apiKey, scope);
    if (principal.environmentKind === "production") {
      return NextResponse.json({ error: { code: "PRODUCTION_KEY_REFUSED", message: "Production keys are refused." } }, { status: 403 });
    }

    if (typeof body.subjectRef !== "string" || typeof body.captureSessionToken !== "string" || typeof body.imageB64 !== "string") {
      throw new VerificationError("subjectRef, captureSessionToken and imageB64 are required.", "INVALID_REQUEST");
    }
    const fingerprint = body.modality === "fingerprint";
    const imageBytes = Buffer.from(body.imageB64, "base64");

    if (purpose === "enrolment") {
      const noticeVersion = typeof body.noticeVersion === "string" && body.noticeVersion ? body.noticeVersion : null;
      if (!noticeVersion) throw new VerificationError("noticeVersion is required for enrolment.", "CONSENT_INVALID", 422);
      const input = {
        subjectRef: body.subjectRef,
        captureSessionToken: body.captureSessionToken,
        imageBytes,
        consent: {
          noticeVersion,
          purpose: "identity_enrolment_verify_lab",
          lawfulBasis: "consent", // lab captures are the operator's own, consented on-screen
        },
        sourceType: "live_capture" as const,
      };
      const result = fingerprint
        ? await enrolFingerprint(db, principal, getFingerprintProvider(), input)
        : await enrolSubject(db, principal, getProvider(), input);
      return NextResponse.json({
        decision: "approved",
        message: "Enrolment completed. An encrypted reference template was stored; the capture image was discarded.",
        subjectId: result.subjectId, templateId: result.templateId,
      }, { status: 201 });
    }

    const input = {
      subjectRef: body.subjectRef,
      captureSessionToken: body.captureSessionToken,
      imageBytes,
      requestId: request.headers.get("x-request-id") ?? undefined,
    };
    const outcome = fingerprint
      ? await verifyFingerprint(db, principal, getFingerprintProvider(), input)
      : await verifySubject(db, principal, getProvider(), input);
    return NextResponse.json({ ...outcome }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
