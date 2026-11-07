import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { asId, badRequest } from "@/lib/http";
import { db, SOURCES_DIR } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * The PDF a source was read from, as it was given — what the reader's page
 * view draws.
 *
 * Only PDFs: they are the one kind with a layout worth showing as it is. A
 * photograph is stored as the one-page PDF it was turned into, so it comes
 * through here too.
 *
 * Answers byte ranges, because pdf.js asks for them: a six-hundred-page book
 * opens on its first page without the whole file crossing first.
 *
 * The stored path is absolute and written on the machine that added the
 * source, so a library copied to another machine (or another folder) points
 * somewhere that no longer exists. The file is looked for beside the others
 * in data/sources under its own name before giving up.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");

  const row = db().prepare("SELECT kind, path FROM sources WHERE id=?").get(id) as
    | { kind: string; path: string | null }
    | undefined;
  if (!row || row.kind !== "pdf" || !row.path) return new NextResponse(null, { status: 404 });

  const file = locate(row.path);
  if (!file) return new NextResponse(null, { status: 404 });

  const size = (await fs.promises.stat(file)).size;
  if (size === 0) return new NextResponse(null, { status: 404 });
  const headers: Record<string, string> = {
    "content-type": "application/pdf",
    "accept-ranges": "bytes",
    // The file under a source never changes once stored.
    "cache-control": "private, max-age=3600",
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) {
      return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    return new NextResponse(stream(file, start, end), {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": String(end - start + 1),
      },
    });
  }

  return new NextResponse(stream(file, 0, size - 1), {
    headers: { ...headers, "content-length": String(size) },
  });
}

function locate(stored: string): string | null {
  if (fs.existsSync(stored)) return stored;
  const beside = path.join(SOURCES_DIR, path.basename(stored));
  return fs.existsSync(beside) ? beside : null;
}

function stream(file: string, start: number, end: number): ReadableStream<Uint8Array> {
  return Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
}
