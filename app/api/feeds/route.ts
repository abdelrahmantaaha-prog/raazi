import { NextResponse } from "next/server";
import { badRequest, optionalString, readBody } from "@/lib/http";
import { addFeed, listFeeds, newsQueryFeedUrl } from "@/lib/feeds";
import { queuePolls } from "@/lib/pipeline/poll";
import { pollInFlight } from "@/lib/pipeline/poll";
import { accepted } from "@/lib/http";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ feeds: listFeeds() });
}

export async function POST(req: Request) {
  const body = await readBody<{
    action?: "add" | "watchPhrase" | "pollNow";
    url?: string;
    phrase?: string;
    title?: string;
    outlet?: string;
    reliability?: string;
    intervalMinutes?: number;
    dailyCap?: number;
    tags?: number[];
    /** Read what the feed already carries, rather than only what comes next. */
    includeExisting?: boolean;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  // "Check the feeds now", for when you do not want to wait for the interval.
  if (body.action === "pollNow") {
    const running = pollInFlight();
    if (running) return accepted(0, "The feeds are already being checked.");
    const queued = queuePolls("Checking feeds now");
    if (!queued) return NextResponse.json({ queued: 0, note: "No feed is due yet." });
    kickWorker();
    return NextResponse.json(queued);
  }

  const url =
    body.action === "watchPhrase"
      ? body.phrase?.trim()
        ? newsQueryFeedUrl(body.phrase.trim())
        : undefined
      : optionalString(body.url)?.trim();

  if (!url) return badRequest("A feed needs an address, or a phrase to watch.");

  const title = optionalString(body.title);
  const outlet = optionalString(body.outlet);
  const reliability = optionalString(body.reliability);
  if (title === null || outlet === null || reliability === null) {
    return badRequest("title, outlet and reliability must be strings.");
  }

  const interval = body.intervalMinutes;
  if (interval !== undefined && (!Number.isInteger(interval) || interval < 5 || interval > 1440)) {
    return badRequest("Check a feed no more often than every five minutes, and at least daily.");
  }
  const cap = body.dailyCap;
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 1 || cap > 500)) {
    return badRequest("A daily cap between 1 and 500.");
  }

  try {
    const feed = await addFeed({
      url,
      title: title ?? (body.action === "watchPhrase" ? `Watch: ${body.phrase}` : undefined),
      outlet: outlet ?? undefined,
      reliability: reliability ?? undefined,
      intervalMinutes: interval,
      dailyCap: cap,
      tags: (body.tags ?? []).filter((t) => Number.isInteger(t) && t > 0),
      // A feed added with "read what it already has" starts from the beginning
      // of what it offers; otherwise from now, which is almost always right.
      since: body.includeExisting ? null : undefined,
    });
    kickWorker();
    return NextResponse.json({ ...feed, feeds: listFeeds() });
  } catch (err) {
    // A feed that does not parse is a typo, and the message says which.
    return badRequest((err as Error).message.slice(0, 300));
  }
}
