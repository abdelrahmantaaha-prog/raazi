import { NextResponse } from "next/server";
import { everything } from "@/lib/sync";

export const dynamic = "force-dynamic";

/**
 * Every discipline this machine holds, with a fingerprint each, and the
 * settings that go with them — what a peer pulling everything asks first.
 * It carries the API keys, so it is behind the LAN token like every other
 * route; the token and the pairings themselves are left out.
 */
export async function GET() {
  return NextResponse.json(everything(), { headers: { "cache-control": "no-store" } });
}
