import { db } from "../db";
import { enqueue, finishTask } from "../queue";
import { backfillCoords, cachedPortrait, fetchPortrait, knownMiss } from "../portraits";
import type { Task } from "../types";

/**
 * Pictures for entries.
 *
 * Runs through the same durable queue as everything else, for the same reason:
 * Wikidata rate-limits hard, so several hundred lookups is ten minutes of
 * patient trickle, and a ten-minute job must survive the app being closed.
 *
 * It spends no tokens at all, which is the point — it can run while every
 * model key in the ring is exhausted.
 */

export async function handlePortrait(task: Task): Promise<void> {
  const { entityId } = JSON.parse(task.payload_json) as { entityId: number };

  if (cachedPortrait(entityId)) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Already has one.");
    return;
  }

  // A rate limit is deliberately allowed to escape: the worker's classifier
  // sees the 429 and puts the task back with a wait, which is right. Recording
  // it as a miss would mean this entity is never asked about again.
  const outcome = await fetchPortrait(entityId);
  finishTask(
    task.id,
    task.run_id,
    { tokensIn: 0, tokensOut: 0 },
    // A miss is a real answer, not a failure — it is recorded so the entity is
    // not asked about again, and the task is done rather than retried.
    outcome.state === "hit" ? "done" : "skipped",
    outcome.note
  );
}

/**
 * Which entities are worth a picture.
 *
 * Only ones with an entry. The library holds thousands of names and a few
 * hundred entries; a name mentioned once in passing has no page to decorate,
 * and asking Wikidata about it would be several hours of politeness spent on
 * nothing.
 */
export async function handlePlanPortraits(task: Task): Promise<void> {
  const { force } = JSON.parse(task.payload_json) as { force?: boolean };

  // Entities looked up before coordinates were kept get them now, in batches
  // of forty — a few requests for the whole backlog, so it is not worth
  // gating behind a flag.
  const placed = await backfillCoords();

  const targets = db()
    .prepare(
      `SELECT e.id FROM entities e
        WHERE e.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM entries en WHERE en.entity_id = e.id)
        ORDER BY (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id = e.id) DESC`
    )
    .all() as { id: number }[];

  // Anything already looked at is left alone unless you ask again: a miss is
  // usually permanent, and re-asking is what would make this expensive.
  const todo = force ? targets : targets.filter((t) => !cachedPortrait(t.id) && !knownMiss(t.id));

  enqueue(
    task.run_id,
    todo.map((t) => ({ kind: "portrait" as const, payload: { entityId: t.id } }))
  );

  const note =
    (todo.length === 0
      ? `Nothing to look up — all ${targets.length} entries have been checked.`
      : `Looking up ${todo.length} of ${targets.length} entries. Roughly ${Math.ceil(
          (todo.length * 2.4) / 60
        )} minute(s).`) +
    (placed ? ` Placed ${placed} on the map from records already matched.` : "");

  finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "done", note);
}
