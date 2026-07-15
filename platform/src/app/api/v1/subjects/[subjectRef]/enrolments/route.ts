import { NextRequest } from "next/server";
import { withApiKey, getProvider, getFingerprintProvider } from "@/server/api/http";
import { getDb } from "@/server/runtime";
import { enrolFingerprint, enrolSubject, VerificationError, type ConsentInput } from "@/server/verification/service";

export const dynamic = "force-dynamic";

/** POST /v1/subjects/:subjectRef/enrolments — consent-led reference enrolment. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ subjectRef: string }> }) {
  const { subjectRef } = await params;
  return withApiKey(request, "enrolment:create", async (principal, body) => {
    const consent = body.consent as ConsentInput | undefined;
    if (!consent) throw new VerificationError("A consent object is required for enrolment.", "CONSENT_MISSING", 422);
    if (typeof body.captureSessionToken !== "string" || typeof body.imageB64 !== "string") {
      throw new VerificationError("captureSessionToken and imageB64 are required.", "INVALID_REQUEST");
    }
    if (body.modality !== undefined && body.modality !== "face" && body.modality !== "fingerprint") {
      throw new VerificationError("modality must be 'face' or 'fingerprint'.", "INVALID_MODALITY");
    }
    const db = await getDb();
    const input = {
      subjectRef,
      captureSessionToken: body.captureSessionToken,
      imageBytes: Buffer.from(body.imageB64, "base64"),
      consent,
      sourceType: (body.sourceType === "document_portrait" ? "document_portrait" : "live_capture") as
        "live_capture" | "document_portrait",
    };
    const result = body.modality === "fingerprint"
      ? await enrolFingerprint(db, principal, getFingerprintProvider(), input)
      : await enrolSubject(db, principal, getProvider(), input);
    return { status: 201, body: { subjectId: result.subjectId, templateId: result.templateId, consentId: result.consentId } };
  });
}
