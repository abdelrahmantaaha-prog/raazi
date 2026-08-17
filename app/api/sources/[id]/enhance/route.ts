import { NextResponse } from "next/server";
import { asId, badRequest } from "@/lib/http";
import { db, tx } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";
import { ENTITY_TYPES } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Reads a source again looking only for what was missed, keeping everything
 * already extracted.
 *
 * The contrast with /reextract is the whole point. That one deletes this
 * source's entities, quotes, relations and events and rebuilds them from
 * nothing, which is correct after a prompt change and catastrophic if you
 * only wanted more. This adds.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");

  const source = db().prepare("SELECT id, title FROM sources WHERE id=?").get(id) as
    | { id: number; title: string }
    | undefined;
  if (!source) return NextResponse.json({ error: "No such source." }, { status: 404 });

  // Only passages that have actually been read. An unread one is not missing
  // detail — it is missing entirely, and ordinary extraction is both cheaper
  // and better at that.
  const chunks = db()
    .prepare(
      "SELECT id FROM chunks WHERE source_id=? AND extracted_at IS NOT NULL ORDER BY seq"
    )
    .all(id) as { id: number }[];

  if (chunks.length === 0) {
    return NextResponse.json(
      { error: "Nothing has been read from this source yet, so there is nothing to enhance." },
      { status: 400 }
    );
  }

  const runId = createRun({
    sourceId: id,
    kind: "enhance",
    label: `Enhancing ${source.title}`,
    budgetCap: getConfig().defaultBudget,
  });

  tx(() => {
    enqueue(
      runId,
      chunks.map((c) => ({ kind: "enhance" as const, payload: { chunkId: c.id } }))
    );
    // Anything new needs reconciling against the rest of the library, and the
    // entries it touches need rewriting — same tail as any other reading.
    enqueue(
      runId,
      ENTITY_TYPES.map((type) => ({ kind: "resolve" as const, payload: { type } }))
    );
    // Free, and finds far more than the model does: every further passage that
    // names an entity already known here.
    enqueue(runId, [{ kind: "sweep" as const, payload: { sourceId: id } }]);
    enqueue(runId, [{ kind: "plan_context" as const, payload: { sourceId: id } }]);
    enqueue(runId, [{ kind: "plan_entries" as const, payload: {} }]);
  });

  kickWorker();

  return NextResponse.json({
    runId,
    passages: chunks.length,
    note: `Looking again at ${chunks.length} passage(s) for what the first reading missed. Nothing already extracted is touched — entries only grow.`,
  });
}
