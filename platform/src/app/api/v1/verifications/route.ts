import { NextRequest } from "next/server";
import { withApiKey, getProvider, getFingerprintProvider } from "@/server/api/http";
import { getDb } from "@/server/runtime";
import { verifyFingerprint, verifySubject, VerificationError } from "@/server/verification/service";

export const dynamic = "force-dynamic";

/** POST /v1/verifications — consent-led 1:1 verification against an enrolment. */
export async function POST(request: NextRequest) {
  return withApiKey(request, "verification:create", async (principal, body) => {
    if (typeof body.subjectRef !== "string" || typeof body.captureSessionToken !== "string" || typeof body.imageB64 !== "string") {
      throw new VerificationError("subjectRef, captureSessionToken and imageB64 are required.", "INVALID_REQUEST");
    }
    if (body.modality !== undefined && body.modality !== "face" && body.modality !== "fingerprint") {
      throw new VerificationError("modality must be 'face' or 'fingerprint'.", "INVALID_MODALITY");
    }
    const db = await getDb();
    const input = {
      subjectRef: body.subjectRef,
      captureSessionToken: body.captureSessionToken,
      imageBytes: Buffer.from(body.imageB64, "base64"),
      requestId: request.headers.get("x-request-id") ?? undefined,
    };
    const outcome = body.modality === "fingerprint"
      ? await verifyFingerprint(db, principal, getFingerprintProvider(), input)
      : await verifySubject(db, principal, getProvider(), input);
    return { status: 201, body: { ...outcome } };
  });
}
