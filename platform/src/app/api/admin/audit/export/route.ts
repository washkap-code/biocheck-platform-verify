/** CSV export of the audit trail. Requires audit:export via the policy layer. */
import { NextRequest, NextResponse } from "next/server";
import { getAuthContext, getDb } from "@/server/runtime";
import { exportAuditCsv } from "@/server/audit/service";
import { AuthorizationError } from "@/server/authz/policy";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const url = request.nextUrl;
  const org = url.searchParams.get("org");
  if (!org) return NextResponse.json({ error: "org is required." }, { status: 400 });
  try {
    const db = await getDb();
    const csv = await exportAuditCsv(db, ctx, org, {
      action: url.searchParams.get("action") || undefined,
      actorId: url.searchParams.get("actor") || undefined,
      outcome: url.searchParams.get("outcome") || undefined,
      from: url.searchParams.get("from") ? new Date(url.searchParams.get("from")!) : undefined,
      to: url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : undefined,
    });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="biocheck-audit-${org.slice(0, 8)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return NextResponse.json({ error: "Your role does not permit audit export." }, { status: 403 });
    }
    throw err;
  }
}
