import { NextResponse } from "next/server";
import { accepted, asId, badRequest, exists, inFlight, notFound } from "@/lib/http";
import { db } from "@/lib/db";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";
import { passagesNeedingContext } from "@/lib/pipeline/context";

export const dynamic = "force-dynamic";

/** How much of this source is quoted in a way that cannot be understood alone. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (!exists("sources", id)) return notFound("No such source.");
  const { chunkIds, quotes } = passagesNeedingContext(id);
  return NextResponse.json({ quotes, passages: chunkIds.length });
}

/** A context run already open for this source, if there is one. */
function contextRunFor(sourceId: number): number | null {
  const row = db()
    .prepare(
      `SELECT r.id FROM runs r
        WHERE r.source_id = ? AND r.kind = 'context'
          AND r.state IN ('queued','running','paused_quota','paused_key','paused_budget')
          AND EXISTS (SELECT 1 FROM tasks t WHERE t.run_id = r.id AND t.state IN ('pending','running'))
        ORDER BY r.id DESC LIMIT 1`
    )
    .get(sourceId) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Resolving them.
 *
 * Queued per passage rather than as one job, so a long book makes progress
 * visibly and a quota pause resumes where it stopped, like every other stage.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const source = db().prepare("SELECT title FROM sources WHERE id=?").get(id) as
    | { title: string }
    | undefined;
  if (!source) return notFound("No such source.");

  // One pass per source at a time. The tasks are per passage, so the guard is
  // on the run rather than on any one chunk.
  const running = contextRunFor(id) ?? inFlight("plan_context", { sourceId: id });
  if (running) return accepted(running, "Context is already being restored for this source.");

  const { chunkIds, quotes } = passagesNeedingContext(id);

  if (chunkIds.length === 0) {
    return NextResponse.json({ runId: null, quotes: 0, passages: 0 });
  }

  const runId = createRun({ sourceId: id, kind: "context", label: `Restoring context in ${source.title}` });
  enqueue(
    runId,
    chunkIds.map((chunkId) => ({ kind: "context" as const, payload: { chunkId } }))
  );
  kickWorker();

  return NextResponse.json({ runId, quotes, passages: chunkIds.length });
}
