import { NextRequest } from "next/server";
import { withApiKey } from "@/server/api/http";
import { getDb } from "@/server/runtime";
import { getVerification } from "@/server/verification/service";

export const dynamic = "force-dynamic";

/** GET /v1/verifications/:id */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, "verification:read", async (principal) => {
    const db = await getDb();
    const verification = await getVerification(db, principal, id);
    return { status: 200, body: verification as Record<string, unknown> };
  });
}
