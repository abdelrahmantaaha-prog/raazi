import { NextResponse } from "next/server";
import { accepted, asId, badRequest, inFlight, notFound } from "@/lib/http";
import { tx } from "@/lib/db";
import { getDraft } from "@/lib/drafts";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/**
 * Queues a fact-check. Goes through the ordinary run machinery so it inherits
 * key rotation, quota backoff and resumability — and it is priority 0, because
 * you pressed the button and are sitting there.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const draft = getDraft(id);
  if (!draft) return notFound("No such draft.");
  if (!draft.body_md.trim()) {
    return NextResponse.json({ error: "Write something first." }, { status: 400 });
  }

  // One check per draft at a time. A second click while the first is queued
  // is impatience, not a second question.
  const running = inFlight("factcheck", { draftId: id });
  if (running) return accepted(running, "This draft is already being checked.");

  const runId = createRun({ kind: "factcheck", label: `Fact-check: ${draft.title}` });
  tx(() => enqueue(runId, [{ kind: "factcheck" as const, payload: { draftId: id } }]));
  kickWorker();

  return NextResponse.json({ runId });
}

/** Polled by the desk while a check is in flight. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const draft = getDraft(id);
  if (!draft) return notFound("No such draft.");

  // Exact match on the draft id inside the payload. A LIKE on `"draftId":5`
  // also matched drafts 50 and 512, so this draft showed a spinner whenever
  // some other one was being checked.
  const runId = inFlight("factcheck", { draftId: id });

  return NextResponse.json({
    running: runId !== null,
    runId,
    checkedAt: draft.checked_at,
    report: draft.check_json ? JSON.parse(draft.check_json) : null,
  });
}
