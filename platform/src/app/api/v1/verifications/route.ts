import { NextRequest } from "next/server";
import { withApiKey, getProvider } from "@/server/api/http";
import { getDb } from "@/server/runtime";
import { verifySubject, VerificationError } from "@/server/verification/service";

export const dynamic = "force-dynamic";

/** POST /v1/verifications — consent-led 1:1 verification against an enrolment. */
export async function POST(request: NextRequest) {
  return withApiKey(request, "verification:create", async (principal, body) => {
    if (typeof body.subjectRef !== "string" || typeof body.captureSessionToken !== "string" || typeof body.imageB64 !== "string") {
      throw new VerificationError("subjectRef, captureSessionToken and imageB64 are required.", "INVALID_REQUEST");
    }
    const db = await getDb();
    const outcome = await verifySubject(db, principal, getProvider(), {
      subjectRef: body.subjectRef,
      captureSessionToken: body.captureSessionToken,
      imageBytes: Buffer.from(body.imageB64, "base64"),
      requestId: request.headers.get("x-request-id") ?? undefined,
    });
    return { status: 201, body: { ...outcome } };
  });
}
