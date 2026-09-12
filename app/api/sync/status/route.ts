import { NextResponse } from "next/server";
import { localStatus } from "@/lib/sync";

export const dynamic = "force-dynamic";

/** What a peer asks before it copies: who this is and what the library holds. */
export async function GET() {
  return NextResponse.json(localStatus(), { headers: { "cache-control": "no-store" } });
}
