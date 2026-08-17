import fs from "node:fs";
import { NextResponse } from "next/server";
import { asId, badRequest } from "@/lib/http";
import { cachedCover, ensureVideoMeta, fetchCover, knownMiss } from "@/lib/covers";

export const dynamic = "force-dynamic";

/**
 * Serves a source's cover, fetching it once on first request. A 404 is a normal
 * answer — the UI draws its own cover from the title when there is nothing.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");

  // Before the cover, because a video whose thumbnail is already cached would
  // otherwise never get past the early return below — and its title is the
  // thing you actually read on the shelf.
  await ensureVideoMeta(id);

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
  const file = cachedCover(id);
  if (file) await fs.promises.unlink(file).catch(() => {});
  const { db } = await import("@/lib/db");
  const row = db().prepare("SELECT meta_json FROM sources WHERE id=?").get(id) as
    | { meta_json: string }
    | undefined;
  const meta = JSON.parse(row?.meta_json ?? "{}") as Record<string, unknown>;
  delete meta.cover;
  db().prepare("UPDATE sources SET meta_json=? WHERE id=?").run(JSON.stringify(meta), id);
  return NextResponse.json({ ok: true });
}
