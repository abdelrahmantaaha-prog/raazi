import { NextResponse } from "next/server";
import { asId, badRequest } from "@/lib/http";
import { db, tx } from "@/lib/db";
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
  if (!draft) return NextResponse.json({ error: "No such draft." }, { status: 404 });
  if (!draft.body_md.trim()) {
    return NextResponse.json({ error: "Write something first." }, { status: 400 });
  }

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
  if (!draft) return NextResponse.json({ error: "No such draft." }, { status: 404 });

  const running = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t JOIN runs r ON r.id = t.run_id
        WHERE t.kind='factcheck' AND t.state IN ('pending','running')
          AND t.payload_json LIKE ?`
    )
    .get(`%"draftId":${id}%`) as { n: number };

  return NextResponse.json({
    running: running.n > 0,
    checkedAt: draft.checked_at,
    report: draft.check_json ? JSON.parse(draft.check_json) : null,
  });
}
