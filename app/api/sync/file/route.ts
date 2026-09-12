import fs from "node:fs";
import { Readable } from "node:stream";
import { badRequest, notFound } from "@/lib/http";
import { resolveFile } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

/** One file under data/, by the relative name the listing gave. */
export async function GET(req: Request) {
  const rel = new URL(req.url).searchParams.get("path") ?? "";
  const abs = resolveFile(rel);
  if (!abs) return badRequest("Not a file this route serves.");
  if (!fs.existsSync(abs)) return notFound("No such file.");
  const size = fs.statSync(abs).size;
  return new Response(Readable.toWeb(fs.createReadStream(abs)) as ReadableStream, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "cache-control": "no-store",
    },
  });
}
