import { NextResponse } from "next/server";
import { accepted, asId, badRequest, inFlight, notFound, readBody } from "@/lib/http";
import { db } from "@/lib/db";
import { canSearchWeb } from "@/lib/ai/client";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";
import { addUrl } from "@/lib/ingest";
import { createReview, getReview, markAdded, reviewsFor, setReviewRun, type LitTarget } from "@/lib/litreview";

export const dynamic = "force-dynamic";

/** How much of a highlight, and of the paragraph around it, is worth sending. */
const MAX_FOCUS = 4_000;
const MAX_CONTEXT = 6_000;

const targetOf = (v: unknown): LitTarget | null => (v === "draft" || v === "source" ? v : null);
const textOf = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : null;

/**
 * One review by id (`?id=`), or the reviews of a text (`?target=&targetId=`,
 * and `&focus=` for one passage), newest first.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const id = asId(params.get("id"));
  if (id !== null) {
    const review = getReview(id);
    return review ? NextResponse.json({ review }) : notFound("No such review.");
  }
  const target = targetOf(params.get("target"));
  const targetId = asId(params.get("targetId"));
  if (!target || targetId === null) return badRequest("Say which review, or which text.");
  const focus = params.has("focus") ? textOf(params.get("focus"), MAX_FOCUS) : undefined;
  return NextResponse.json({ reviews: reviewsFor(target, targetId, focus), canSearch: canSearchWeb() });
}

/**
 * Start a review: `{target, id, focus?, context?}`.
 * Add one of its results to the library: `{action: "add", reviewId, index}`.
 */
export async function POST(req: Request) {
  const body = await readBody<{
    action?: "start" | "add";
    target?: string;
    id?: number;
    focus?: string;
    context?: string;
    reviewId?: number;
    index?: number;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  if (body.action === "add") {
    const reviewId = asId(body.reviewId ?? null);
    const review = reviewId === null ? undefined : getReview(reviewId);
    const index = Number(body.index);
    const result = Number.isInteger(index) ? review?.report?.results[index] : undefined;
    if (!review || !result) return notFound("No such result.");
    if (result.sourceId) return NextResponse.json({ review, sourceId: result.sourceId });
    try {
      const added = await addUrl({
        url: result.url,
        title: result.title,
        ...(result.outlet ? { outlet: result.outlet } : {}),
        // When the page cannot be read — a paywall, a PDF behind a login —
        // what the review said about it is still a dated, attributed record.
        fallbackText: [result.title, result.authors, result.outlet, result.date, result.finding].filter(Boolean).join("\n\n"),
      });
      if (added.runId) kickWorker();
      return NextResponse.json({ review: markAdded(review.id, index, added.sourceId), sourceId: added.sourceId, note: added.note });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message || "Could not add that page." }, { status: 500 });
    }
  }

  const target = targetOf(body.target);
  const id = asId(body.id ?? null);
  if (!target || id === null) return badRequest("Say which draft or source.");
  if (!canSearchWeb()) return badRequest("A literature review needs Claude (your plan), which searches the web. Add it in Settings first.");

  const row =
    target === "draft"
      ? (db().prepare("SELECT title FROM drafts WHERE id=?").get(id) as { title: string } | undefined)
      : (db().prepare("SELECT title FROM sources WHERE id=?").get(id) as { title: string } | undefined);
  if (!row) return notFound(target === "draft" ? "No such draft." : "No such source.");

  const focus = textOf(body.focus, MAX_FOCUS);
  const context = focus ? textOf(body.context, MAX_CONTEXT) : null;

  // The same text asked about twice while the first is still searching gets the first.
  const running = reviewsFor(target, id, focus).find((r) => r.state === "running" || r.state === "waiting");
  if (running?.run_id && inFlight("litreview", { reviewId: running.id })) {
    return accepted(running.run_id, "This is already being searched.", { reviewId: running.id });
  }

  const title = row.title?.trim() || (target === "draft" ? "Untitled draft" : "Untitled source");
  const reviewId = createReview({ target, targetId: id, focus, context, title });
  const label = focus ? `Literature review: “${focus.slice(0, 50)}${focus.length > 50 ? "…" : ""}”` : `Literature review: ${title}`;
  const runId = createRun({ kind: "webcheck", label });
  setReviewRun(reviewId, runId);
  enqueue(runId, [{ kind: "litreview", payload: { reviewId } }]);
  kickWorker();
  return NextResponse.json({ reviewId, runId });
}
