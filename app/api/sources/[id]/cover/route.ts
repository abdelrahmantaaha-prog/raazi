import fs from "node:fs";
import { NextResponse } from "next/server";
import { asId, badRequest, exists, notFound } from "@/lib/http";
import { db } from "@/lib/db";
import { cachedCover, ensureVideoMeta, fetchCover, knownMiss } from "@/lib/covers";

export const dynamic = "force-dynamic";

/**
 * Sources whose one-time video bookkeeping has been done in this process.
 *
 * `ensureVideoMeta` is idempotent — it checks two flags in the source's meta
 * and writes each once — but checking costs a row read and a JSON parse on
 * every cover request, and the shelf asks for every cover on every render.
 * After the first look a source is remembered here and the GET is then purely
 * a file read. Cleared by DELETE, which is the one thing that makes the
 * question worth asking again.
 */
const videoMetaSettled = new Set<number>();

/**
 * Serves a source's cover, fetching it once on first request. A 404 is a normal
 * answer — the UI draws its own cover from the title when there is nothing.
 *
 * This GET does write, and deliberately: the first request for a cover is
 * what fetches it to disk, and the first request for a video's cover is what
 * fills in its title. Both happen once per source and never again, which is
 * what makes a read-only GET the right shape for the two thousand requests
 * that follow. Nothing a caller sends influences what is written.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");

  // Before the cover, because a video whose thumbnail is already cached would
  // otherwise never get past the early return below — and its title is the
  // thing you actually read on the shelf.
  if (!videoMetaSettled.has(id)) {
    if (!exists("sources", id)) return new NextResponse(null, { status: 404 });
    await ensureVideoMeta(id);
    videoMetaSettled.add(id);
  }

  let file = cachedCover(id);
  if (!file && !knownMiss(id)) file = await fetchCover(id);
  if (!file) return new NextResponse(null, { status: 404 });

  const bytes = await fs.promises.readFile(file);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/jpeg",
      // It is on our own disk; there is no reason to ask again this session.
      "cache-control": "public, max-age=86400, immutable",
    },
  });
}

/** Forget what we found and look again. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const row = db().prepare("SELECT meta_json FROM sources WHERE id=?").get(id) as
    | { meta_json: string }
    | undefined;
  if (!row) return notFound("No such source.");

  const file = cachedCover(id);
  if (file) await fs.promises.unlink(file).catch(() => {});

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(row.meta_json || "{}") as Record<string, unknown>;
  } catch {
    // A meta column that does not parse is not worth keeping; start clean.
  }
  delete meta.cover;
  delete meta.coverAt;
  db().prepare("UPDATE sources SET meta_json=? WHERE id=?").run(JSON.stringify(meta), id);
  videoMetaSettled.delete(id);
  return NextResponse.json({ ok: true });
}
