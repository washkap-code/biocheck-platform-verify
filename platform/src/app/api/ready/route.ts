import { NextResponse } from "next/server";
import { getDb } from "@/server/runtime";

export const dynamic = "force-dynamic";

/**
 * Readiness: database reachable and migrations applied. Binary answer only —
 * no versions, no hostnames, no table names, no sensitive detail.
 */
export async function GET() {
  try {
    const db = await getDb();
    await db.query(`SELECT 1`);
    return NextResponse.json({ status: "ready" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
