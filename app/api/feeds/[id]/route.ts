import { NextResponse } from "next/server";
import { asId, badRequest, notFound, optionalString, readBody } from "@/lib/http";
import { db, tx } from "@/lib/db";
import { deleteFeed, getFeed, listFeeds, setFeedTags, updateFeed } from "@/lib/feeds";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = asId((await params).id);
  if (!id) return badRequest("Bad feed id.");
  const feed = getFeed(id);
  if (!feed) return notFound("No such feed.");

  const items = db()
    .prepare(
      `SELECT i.*, s.title AS source_title
         FROM feed_items i LEFT JOIN sources s ON s.id = i.source_id
        WHERE i.feed_id=? ORDER BY COALESCE(i.published_at, i.seen_at) DESC LIMIT 100`
    )
    .all(id);
  return NextResponse.json({ feed, items });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = asId((await params).id);
  if (!id) return badRequest("Bad feed id.");
  if (!getFeed(id)) return notFound("No such feed.");

  const body = await readBody<{
    action?: "update" | "poll" | "tags";
    title?: string;
    outlet?: string;
    reliability?: string;
    enabled?: boolean;
    intervalMinutes?: number;
    dailyCap?: number;
    tagIds?: number[];
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  if (body.action === "poll") {
    const runId = tx(() => {
      const run = createRun({ kind: "poll", label: `Checking ${getFeed(id)!.title}` });
      enqueue(run, [{ kind: "poll" as const, payload: { feedId: id } }]);
      return run;
    });
    kickWorker();
    return NextResponse.json({ runId });
  }

  if (body.action === "tags") {
    const tagIds = (body.tagIds ?? []).filter((t) => Number.isInteger(t) && t > 0);
    setFeedTags(id, tagIds);
    return NextResponse.json({ ok: true });
  }

  const title = optionalString(body.title);
  const outlet = optionalString(body.outlet);
  const reliability = optionalString(body.reliability);
  if (title === null || outlet === null || reliability === null) {
    return badRequest("title, outlet and reliability must be strings.");
  }
  if (body.intervalMinutes !== undefined && (!Number.isInteger(body.intervalMinutes) || body.intervalMinutes < 5)) {
    return badRequest("Check a feed no more often than every five minutes.");
  }
  if (body.dailyCap !== undefined && (!Number.isInteger(body.dailyCap) || body.dailyCap < 1)) {
    return badRequest("A daily cap of at least one.");
  }

  updateFeed(id, {
    ...(title !== undefined ? { title } : {}),
    ...(outlet !== undefined ? { outlet } : {}),
    ...(reliability !== undefined ? { reliability } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled ? 1 : 0 } : {}),
    ...(body.intervalMinutes !== undefined ? { interval_minutes: body.intervalMinutes } : {}),
    ...(body.dailyCap !== undefined ? { daily_cap: body.dailyCap } : {}),
  });
  return NextResponse.json({ feed: getFeed(id), feeds: listFeeds() });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = asId((await params).id);
  if (!id) return badRequest("Bad feed id.");
  // The sources it already brought in stay: they are yours now, and the items
  // go with the feed only so that removing and re-adding it does not re-read
  // everything it has ever carried.
  if (!deleteFeed(id)) return notFound("No such feed.");
  return NextResponse.json({ ok: true, feeds: listFeeds() });
}
