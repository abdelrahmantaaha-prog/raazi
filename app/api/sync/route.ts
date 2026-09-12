import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { localStatus, peerStatus, saveSyncSettings, syncSettings, type LocalStatus } from "@/lib/sync";

export const dynamic = "force-dynamic";

/**
 * What the Settings card shows: this machine, the saved peer, and — when a
 * peer is saved and answers — the peer's own status beside it.
 */
export async function GET() {
  const settings = syncSettings();
  let peer: LocalStatus | null = null;
  let peerError: string | null = null;
  if (settings.peerUrl && settings.peerToken) {
    try {
      peer = await peerStatus({ url: settings.peerUrl, token: settings.peerToken });
    } catch (err) {
      peerError = (err as Error).message;
    }
  }
  return NextResponse.json({ local: localStatus(), settings, peer, peerError });
}

/** Saves the peer's address and token. */
export async function POST(req: Request) {
  const body = await readBody<{ peerUrl?: string; peerToken?: string }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  const patch: { peerUrl?: string; peerToken?: string } = {};
  if (body.peerUrl !== undefined) {
    if (typeof body.peerUrl !== "string") return badRequest("peerUrl must be a string.");
    const url = body.peerUrl.trim();
    if (url && !/^https?:\/\/[^/\s]+/i.test(url)) return badRequest("The address must look like http://host:5400.");
    patch.peerUrl = url;
  }
  if (body.peerToken !== undefined) {
    if (typeof body.peerToken !== "string") return badRequest("peerToken must be a string.");
    patch.peerToken = body.peerToken.trim();
  }
  return NextResponse.json({ settings: saveSyncSettings(patch) });
}
