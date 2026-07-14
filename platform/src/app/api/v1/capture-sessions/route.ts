import { NextRequest } from "next/server";
import { withApiKey } from "@/server/api/http";
import { getDb } from "@/server/runtime";
import { createCaptureSession, VerificationError } from "@/server/verification/service";

export const dynamic = "force-dynamic";

/** POST /v1/capture-sessions — short-lived, one-use, nonce-bound. */
export async function POST(request: NextRequest) {
  return withApiKey(request, "verification:create", async (principal, body) => {
    const purpose = body.purpose === "enrolment" ? "enrolment" : body.purpose === "verification" ? "verification" : null;
    if (!purpose) throw new VerificationError("purpose must be 'enrolment' or 'verification'.", "INVALID_PURPOSE");
    const db = await getDb();
    const session = await createCaptureSession(db, principal, purpose);
    return { status: 201, body: { ...session, notice: "The clientToken is shown once. It expires and is single-use." } };
  });
}
