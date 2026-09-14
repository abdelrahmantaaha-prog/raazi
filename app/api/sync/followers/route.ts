import { NextResponse } from "next/server";
import { primaryWaiting } from "@/lib/follow";

export const dynamic = "force-dynamic";

/** What the launcher asks before opening a primary: is a follower bringing work back. */
export async function GET() {
  return NextResponse.json(primaryWaiting(), { headers: { "cache-control": "no-store" } });
}
