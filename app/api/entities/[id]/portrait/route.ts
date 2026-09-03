import fs from "node:fs";
import { NextResponse } from "next/server";
import { asId, badRequest, exists, notFound, optionalString, readBody } from "@/lib/http";
import {
  cachedPortrait,
  candidates,
  portraitPath,
  portraitState,
  setPortraitState,
  store,
} from "@/lib/portraits";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Serves an entity's picture from disk, or lists candidates for one.
 *
 * `GET` with no query returns the image; `?candidates=1` returns what Wikidata
 * offers, so you can settle by hand what the automatic pass would not accept.
 * Never fetches an image as a side effect of rendering — that is the queue's
 * job, and a page load should not wait on a rate-limited API.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const url = new URL(req.url);

  if (url.searchParams.has("candidates")) {
    const entity = db()
      .prepare("SELECT type, canonical_name FROM entities WHERE id=?")
      .get(id) as { type: string; canonical_name: string } | undefined;
    if (!entity) return notFound("No such entity.");

    const q = url.searchParams.get("q")?.trim() || entity.canonical_name;
    try {
      const found = await candidates(q, entity.type, 8);
      return NextResponse.json({ query: q, results: found.filter((c) => c.file) });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 502 });
    }
  }

  const file = cachedPortrait(id);
  // A 404 is an ordinary answer: most entities have no picture and the page
  // draws its own initial instead.
  if (!file) return new NextResponse(null, { status: 404 });

  const bytes = await fs.promises.readFile(file);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=86400",
    },
  });
}

/** Applies a Wikidata record you picked yourself. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const parsed = await readBody<{ wikidata?: string; file?: string }>(req);
  if (parsed === null) return badRequest("Malformed JSON body.");
  const wikidata = optionalString(parsed.wikidata);
  const file = optionalString(parsed.file);
  if (wikidata === null || file === null) return badRequest("wikidata and file must be strings.");
  if (!wikidata || !file) {
    return NextResponse.json({ error: "Pick a record." }, { status: 400 });
  }
  if (!exists("entities", id)) return notFound("No such entity.");

  try {
    await store(id, file, wikidata);
    setPortraitState(id, {
      portrait: "hit",
      portraitAt: new Date().toISOString(),
      wikidata,
      commons: file,
      portraitBy: "you",
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

/** Removes the picture and forgets that we ever looked. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (!exists("entities", id)) return notFound("No such entity.");
  const file = cachedPortrait(id);
  if (file) await fs.promises.unlink(portraitPath(id)).catch(() => {});

  const state = { ...portraitState(id) };
  delete state.portrait;
  delete state.portraitAt;
  delete state.wikidata;
  delete state.commons;
  delete state.portraitBy;
  db().prepare("UPDATE entities SET meta_json=? WHERE id=?").run(JSON.stringify(state), id);

  return NextResponse.json({ ok: true });
}
