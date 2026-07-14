import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness: process is up. Reveals nothing about configuration or data. */
export async function GET() {
  return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
