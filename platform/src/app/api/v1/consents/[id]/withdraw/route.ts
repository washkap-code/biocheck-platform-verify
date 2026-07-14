import { NextRequest } from "next/server";
import { withApiKey } from "@/server/api/http";
import { getDb } from "@/server/runtime";
import { withdrawConsent } from "@/server/verification/service";

export const dynamic = "force-dynamic";

/** POST /v1/consents/:id/withdraw — revokes templates and notifies via webhook. Idempotent. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, "consent:manage", async (principal) => {
    const db = await getDb();
    await withdrawConsent(db, principal, id);
    return { status: 200, body: { consentId: id, status: "withdrawn" } };
  });
}
