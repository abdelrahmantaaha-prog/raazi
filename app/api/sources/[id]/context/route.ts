import { NextResponse } from "next/server";
import { asId, badRequest } from "@/lib/http";
import { db } from "@/lib/db";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";
import { passagesNeedingContext } from "@/lib/pipeline/context";

export const dynamic = "force-dynamic";

/** How much of this source is quoted in a way that cannot be understood alone. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const { chunkIds, quotes } = passagesNeedingContext(id);
  return NextResponse.json({ quotes, passages: chunkIds.length });
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
  const { chunkIds, quotes } = passagesNeedingContext(id);

  if (chunkIds.length === 0) {
    return NextResponse.json({ runId: null, quotes: 0, passages: 0 });
  }

  const title =
    (db().prepare("SELECT title FROM sources WHERE id=?").get(id) as { title: string } | undefined)
      ?.title ?? `Source ${id}`;

  const runId = createRun({ sourceId: id, kind: "context", label: `Restoring context in ${title}` });
  enqueue(
    runId,
    chunkIds.map((chunkId) => ({ kind: "context" as const, payload: { chunkId } }))
  );
  kickWorker();

  return NextResponse.json({ runId, quotes, passages: chunkIds.length });
}
