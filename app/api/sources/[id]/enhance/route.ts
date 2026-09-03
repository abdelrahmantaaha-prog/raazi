import { NextResponse } from "next/server";
import { accepted, asId, badRequest, notFound } from "@/lib/http";
import { db, tx } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";
import { ENTITY_TYPES, type EntityType } from "@/lib/types";

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
  if (!source) return notFound("No such source.");

  // One enhance per source at a time. Each click used to queue a full pass
  // over every passage plus a resolve pass over every entity type — a double
  // click was twice the spend for nothing.
  const running = db()
    .prepare(
      `SELECT r.id FROM runs r
        WHERE r.source_id = ? AND r.kind = 'enhance'
          AND r.state IN ('queued','running','paused_quota','paused_key','paused_budget')
          AND EXISTS (SELECT 1 FROM tasks t WHERE t.run_id = r.id AND t.state IN ('pending','running'))
        ORDER BY r.id DESC LIMIT 1`
    )
    .get(id) as { id: number } | undefined;
  if (running) return accepted(running.id, "This source is already being enhanced.");

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

  // The resolve tail reconciles by entity type across the whole library, so
  // it is only worth running for the types this source actually has. A book
  // with no places in it does not need every place in the pedia re-adjudicated.
  const present = new Set(
    (
      db()
        .prepare(
          `SELECT DISTINCT e.type FROM mentions m JOIN entities e ON e.id = m.entity_id
            WHERE m.source_id = ?`
        )
        .all(id) as { type: EntityType }[]
    ).map((r) => r.type)
  );
  const types = ENTITY_TYPES.filter((t) => present.has(t));
  // Nothing extracted yet from this source means the second look can find
  // anything; keep the full tail for that one case.
  const resolveTypes = types.length ? types : ENTITY_TYPES;

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
    // entries it touches need rewriting — same tail as any other reading. One
    // tail per run, and only for the types above; a resolve queued in some
    // earlier run would be claimed before this run's passages are read, so
    // it cannot be relied on instead.
    enqueue(
      runId,
      resolveTypes.map((type) => ({ kind: "resolve" as const, payload: { type } }))
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
