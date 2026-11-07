import { NextResponse } from "next/server";
import { requestAllowed } from "@/lib/lan";
import { receiveFile } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

/**
 * One file of a library a follower is sending back, under data/ and nowhere
 * else. Outside the middleware for the reason receive/ is, so it checks the
 * token itself and takes only a binary content type.
 */
export async function PUT(req: Request) {
  if (!requestAllowed(req)) {
    return NextResponse.json({ error: "This Raazi is in LAN mode. Send its token as x-corpus-token." }, { status: 401 });
  }
  if (!/^application\/octet-stream/i.test(req.headers.get("content-type") ?? "")) {
    return NextResponse.json({ error: "Send the file as application/octet-stream." }, { status: 415 });
  }
  if (!req.body) return NextResponse.json({ error: "No file was sent." }, { status: 400 });

  const rel = new URL(req.url).searchParams.get("path") ?? "";
  try {
    const size = await receiveFile(rel, req.body);
    return NextResponse.json({ ok: true, size });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message.slice(0, 300) }, { status: 400 });
  }
}
