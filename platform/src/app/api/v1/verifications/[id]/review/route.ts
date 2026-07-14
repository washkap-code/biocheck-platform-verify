import { NextRequest, NextResponse } from "next/server";
import { getAuthContext, getDb } from "@/server/runtime";
import { decideReviewCase, VerificationError } from "@/server/verification/service";
import { errorResponse } from "@/server/api/http";

export const dynamic = "force-dynamic";

/**
 * POST /v1/verifications/:id/review — a review decision requires a NAMED,
 * signed-in human reviewer (reviews:decide permission) and a written reason.
 * API keys cannot decide reviews; this is a human-only action by design.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ctx = await getAuthContext();
    if (!ctx) {
      return NextResponse.json(
        { error: { code: "UNAUTHENTICATED", message: "Review decisions require a signed-in reviewer session." } },
        { status: 401 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.organisationId !== "string") {
      throw new VerificationError("organisationId is required.", "INVALID_REQUEST");
    }
    const outcome = body.outcome === "approved" ? "approved" : body.outcome === "rejected" ? "rejected" : null;
    if (!outcome) throw new VerificationError("outcome must be 'approved' or 'rejected'.", "INVALID_REQUEST");
    const db = await getDb();
    const result = await decideReviewCase(db, ctx, body.organisationId, id, outcome, String(body.reason ?? ""));
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
