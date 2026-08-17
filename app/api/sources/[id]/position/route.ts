import { NextResponse } from "next/server";
import { asId, badRequest, readBody } from "@/lib/http";
import {
  markReadThrough,
  readAlong,
  recomputeProgress,
  recordPosition,
  resetPosition,
} from "@/lib/reading";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/**
 * Where you are in a source, and what that sets off.
 *
 * Kept against the source rather than in the browser: the whole point of not
 * having a separate reader app is that Corpus is where the book lives, and a
 * position that vanishes with the browser cache is not a position.
 *
 * The same call advances read-along, because the two are the same fact. You
 * have read to here; therefore Corpus may read to here.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const parsed = await readBody<{
    chunkId: number | null;
    offset?: number;
    /** Passages dwelled on since the last save. */
    read?: number[];
    /** Set when you said outright that you have read this far. */
    through?: number;
  }>(req);
  if (parsed === null) return badRequest("Malformed JSON body.");
  const { chunkId, offset, read, through } = parsed;

  if (through) markReadThrough(id, through);

  recordPosition(id, {
    chunkId: chunkId || null,
    offset: offset ?? 0,
    read: Array.isArray(read) ? read : [],
  });

  const along = readAlong(id);
  if (along.queued > 0) kickWorker();

  return NextResponse.json({ ok: true, ...along, progress: recomputeProgress(id) });
}

/** Start it over. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  resetPosition(id);
  return NextResponse.json({ ok: true });
}
