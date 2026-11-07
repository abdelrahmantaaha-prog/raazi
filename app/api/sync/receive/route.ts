import { NextResponse } from "next/server";
import { requestAllowed } from "@/lib/lan";
import { SyncConflictError, receiveSnapshot } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/**
 * A follower sending its library back: this library becomes that copy.
 *
 * Outside the middleware — Next keeps only the first 10 MB of a body it
 * buffers for middleware — so the token is checked here. And only as a
 * library's own content type, which a web page cannot send to another origin
 * without the browser asking this server first, and this server never agrees.
 */
export async function POST(req: Request) {
  if (!requestAllowed(req)) {
    return NextResponse.json({ error: "This Raazi is in LAN mode. Send its token as x-corpus-token." }, { status: 401 });
  }
  if (!/^application\/(vnd\.sqlite3|octet-stream)/i.test(req.headers.get("content-type") ?? "")) {
    return NextResponse.json({ error: "Send the library as application/vnd.sqlite3." }, { status: 415 });
  }
  if (!req.body) return NextResponse.json({ error: "No copy was sent." }, { status: 400 });

  const params = new URL(req.url).searchParams;
  try {
    const result = await receiveSnapshot(req.body, {
      from: (params.get("from") ?? "another computer").slice(0, 100),
      expect: params.get("expect"),
      force: params.get("force") === "1",
    });
    return NextResponse.json({ ok: true, fingerprint: result.fingerprint, backedUp: Boolean(result.backup) });
  } catch (err) {
    if (err instanceof SyncConflictError) {
      return NextResponse.json({ error: err.message, conflict: true }, { status: 409 });
    }
    const message = (err as Error).message;
    const busy = /already running/.test(message);
    return NextResponse.json({ error: message.slice(0, 500), busy }, { status: busy ? 409 : 500 });
  }
}
