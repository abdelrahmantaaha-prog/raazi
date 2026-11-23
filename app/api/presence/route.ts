import { NextResponse } from "next/server";
import { remoteSeenAgoMs } from "@/lib/presence";

export const dynamic = "force-dynamic";

/**
 * "Is anybody else reading from this computer?"
 *
 * Asked by the launcher every few seconds (launcher/Awake.cs) to decide
 * whether to keep Windows from putting the machine to sleep under a phone or
 * another laptop that is using the library. See lib/presence.ts.
 *
 * Behind the token like everything else: with sharing off the server answers
 * this computer only, and the answer is always "nobody".
 */
export async function GET() {
  return NextResponse.json({ remoteSeenAgoMs: remoteSeenAgoMs() }, { headers: { "cache-control": "no-store" } });
}
