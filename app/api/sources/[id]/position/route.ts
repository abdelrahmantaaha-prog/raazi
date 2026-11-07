import { NextResponse } from "next/server";
import { asId, badRequest, exists, notFound, optionalId, readBody } from "@/lib/http";
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
 * having a separate reader app is that Raazi is where the book lives, and a
 * position that vanishes with the browser cache is not a position.
 *
 * The same call advances read-along, because the two are the same fact. You
 * have read to here; therefore Raazi may read to here.
 *
 * Every chunk id here is checked against the source in the URL, inside
 * lib/reading.ts: a foreign one used to count as read *here*, and read-along
 * then handed that other book to the model — a spend path open to any device
 * that could reach the port.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const parsed = await readBody<{
    chunkId: number | null;
    offset?: number;
    /** Passages finished since the last save. */
    read?: number[];
    /** Passages read partway since the last save, and how far into each. */
    partly?: { chunkId: number; share: number }[];
    /** Set when you said outright that you have read this far. */
    through?: number;
    /** How far into `through` you had got, 0 to 1. A whole passage if absent. */
    throughShare?: number;
  }>(req);
  if (parsed === null) return badRequest("Malformed JSON body.");

  const chunkId = optionalId(parsed.chunkId);
  if (chunkId === null) return badRequest("chunkId must be a passage id or null.");
  const through = optionalId(parsed.through);
  if (through === null) return badRequest("through must be a passage id.");
  const offset = parsed.offset === undefined ? 0 : parsed.offset;
  if (typeof offset !== "number") return badRequest("offset must be a number.");
  if (parsed.read !== undefined && !Array.isArray(parsed.read)) {
    return badRequest("read must be a list of passage ids.");
  }
  const read = (parsed.read ?? []).map((n) => asId(n)).filter((n): n is number => n !== null);
  if (parsed.partly !== undefined && !Array.isArray(parsed.partly)) {
    return badRequest("partly must be a list of { chunkId, share }.");
  }
  const partly = (parsed.partly ?? []).flatMap((p) => {
    const id = asId(p?.chunkId);
    return id !== null && typeof p.share === "number" && Number.isFinite(p.share)
      ? [{ chunkId: id, share: p.share }]
      : [];
  });
  const throughShare = parsed.throughShare === undefined ? 1 : parsed.throughShare;
  if (typeof throughShare !== "number" || !Number.isFinite(throughShare)) {
    return badRequest("throughShare must be a number.");
  }

  if (!exists("sources", id)) return notFound("No such source.");

  if (through) markReadThrough(id, through, throughShare);

  recordPosition(id, { chunkId: chunkId ?? null, offset, read, partly });

  const along = readAlong(id);
  if (along.queued > 0) kickWorker();

  return NextResponse.json({ ok: true, ...along, progress: recomputeProgress(id) });
}

/** Start it over. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (!exists("sources", id)) return notFound("No such source.");
  resetPosition(id);
  return NextResponse.json({ ok: true });
}
