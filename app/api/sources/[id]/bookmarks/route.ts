import { NextResponse } from "next/server";
import { asId, badRequest, readBody } from "@/lib/http";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export interface Bookmark {
  id: number;
  chunk_id: number;
  offset: number;
  excerpt: string | null;
  note: string | null;
  created_at: string;
  /** Passage number within the source, for showing position at a glance. */
  seq: number;
  locator: string | null;
}

const LIST = `SELECT b.id, b.chunk_id, b.offset, b.excerpt, b.note, b.created_at,
                     c.seq, c.locator_json AS locator
                FROM bookmarks b
                JOIN chunks c ON c.id = b.chunk_id
               WHERE b.source_id = ?
               ORDER BY c.seq, b.offset`;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  return NextResponse.json({ bookmarks: db().prepare(LIST).all(id) });
}

/**
 * Marks a place. Marking the same passage twice removes the mark instead —
 * the button in the reader is a toggle, and a toggle that silently stacks
 * duplicates is the sort of thing you only discover from a list of nine
 * identical bookmarks.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const parsed = await readBody<{
    chunkId: number;
    offset?: number;
    excerpt?: string;
  }>(req);
  if (parsed === null) return badRequest("Malformed JSON body.");
  const { chunkId, offset, excerpt } = parsed;
  if (!chunkId) return NextResponse.json({ error: "No passage given." }, { status: 400 });

  const existing = db()
    .prepare("SELECT id FROM bookmarks WHERE source_id=? AND chunk_id=?")
    .get(id, chunkId) as { id: number } | undefined;

  if (existing) {
    db().prepare("DELETE FROM bookmarks WHERE id=?").run(existing.id);
    return NextResponse.json({ removed: existing.id, bookmarks: db().prepare(LIST).all(id) });
  }

  db()
    .prepare("INSERT INTO bookmarks (source_id, chunk_id, offset, excerpt) VALUES (?, ?, ?, ?)")
    .run(id, chunkId, Math.max(0, Math.min(1, offset ?? 0)), excerpt?.slice(0, 240) ?? null);

  return NextResponse.json({ bookmarks: db().prepare(LIST).all(id) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const bookmarkId = Number(new URL(req.url).searchParams.get("bookmark"));
  if (bookmarkId) db().prepare("DELETE FROM bookmarks WHERE id=? AND source_id=?").run(bookmarkId, id);
  return NextResponse.json({ bookmarks: db().prepare(LIST).all(id) });
}
