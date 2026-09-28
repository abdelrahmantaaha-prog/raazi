import fs from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { snapshot } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

/**
 * A consistent copy of the database, streamed to a peer that is pulling.
 *
 * Written to a temporary file first by SQLite's online backup (lib/sync.ts),
 * so the copy is whole whatever the worker is doing meanwhile and the server
 * keeps answering while it is made, then streamed and deleted. A copy this
 * machine will not make — no room, or the last one failed moments ago — is
 * answered with the reason, which the follower shows. Behind the LAN token
 * like every other route.
 */
export async function GET() {
  let file: string;
  try {
    file = await snapshot();
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "300" } }
    );
  }
  const size = fs.statSync(file).size;
  const stream = fs.createReadStream(file);
  stream.on("close", () => fs.unlink(file, () => undefined));
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "content-type": "application/vnd.sqlite3",
      "content-length": String(size),
      "cache-control": "no-store",
    },
  });
}
