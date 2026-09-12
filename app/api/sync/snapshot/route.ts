import fs from "node:fs";
import { Readable } from "node:stream";
import { snapshot } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

/**
 * A consistent copy of the database, streamed to a peer that is pulling.
 *
 * Written by VACUUM INTO to a temporary file first, so the copy is whole and
 * checkpointed whatever the worker is doing meanwhile, then streamed and
 * deleted. Behind the LAN token like every other route.
 */
export async function GET() {
  const file = snapshot();
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
