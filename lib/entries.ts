import { db, tx } from "./db";
import { getConfig } from "./config";
import { createRun, enqueue } from "./queue";

/**
 * Deciding which entries need rewriting.
 *
 * Two different questions live here, and conflating them was a bug:
 *
 *   - Does this entity deserve an entry at all? That is the mention threshold,
 *     which exists so a name mentioned once in passing does not cost a call.
 *   - Does an entry that already exists still reflect the evidence? That has
 *     nothing to do with the threshold. An entry written on demand for a
 *     two-mention entity must still be kept current, or the pedia quietly
 *     accumulates entries that contradict their own sources.
 *
 * There used to be a third question — does the entry cite enough of its
 * evidence? — asked here as a coverage ratio, and it was the most expensive
 * mistake in the application. An entry with eight or more quotes citing fewer
 * than 85% of them counted as stale on every idle sweep, while the writer was
 * told (correctly) that it is not scored on how much evidence it uses. The two
 * rules disagreed, nothing remembered that a rewrite had already been tried,
 * and the same twenty-two entries were rewritten on every quiet minute for
 * weeks: thirty million tokens, one entry 296 times. Coverage is now reported
 * (see `undercovered`) and never used to queue work. An entry is rewritten when
 * its evidence changes, when you ask, and otherwise not at all.
 */

export interface StaleEntity {
  id: number;
  canonical_name: string;
  mentions: number;
  has_entry: number;
}

export function staleEntities(threshold = getConfig().entryThreshold): StaleEntity[] {
  return db()
    .prepare(
      `SELECT e.id, e.canonical_name,
              (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id = e.id) AS mentions,
              (SELECT COUNT(*) FROM entries en WHERE en.entity_id = e.id) AS has_entry
         FROM entities e
        WHERE e.merged_into IS NULL
          AND e.entry_state IN ('none', 'stale')
          -- An entity with no evidence left has nothing to write from, and
          -- queueing it would skip every time and never clear the backlog.
          AND EXISTS (SELECT 1 FROM live_mentions m WHERE m.entity_id = e.id)
          AND (
            -- Already written: keep it current whatever its size.
            EXISTS (SELECT 1 FROM entries en WHERE en.entity_id = e.id)
            -- Or big enough to earn a first entry.
            OR (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id = e.id) >= @threshold
            OR e.starred = 1
          )
        ORDER BY has_entry DESC, mentions DESC`
    )
    .all({ threshold }) as StaleEntity[];
}

/** How many entries are waiting to be brought up to date. */
export function staleCount(): { total: number; rewrites: number; newEntries: number } {
  const rows = staleEntities();
  const rewrites = rows.filter((r) => r.has_entry > 0).length;
  return { total: rows.length, rewrites, newEntries: rows.length - rewrites };
}

/**
 * Entries that cite a small share of their evidence — for the Library to show,
 * and for you to decide about. Never queued automatically: the writer is
 * allowed to leave a quote out, and an entry that stays at 70% after a rewrite
 * is telling you the remaining quotes are duplicates or unusable, not asking
 * to be written again.
 */
export function undercovered(minMentions = 8, ratio = 0.85): { id: number; canonical_name: string; cited: number; total: number }[] {
  return db()
    .prepare(
      `SELECT e.id, e.canonical_name,
              (SELECT COUNT(*) FROM live_mentions m
                WHERE m.entity_id = e.id
                  AND instr(en.body_md, '[[m:' || m.id || ']]') > 0) AS cited,
              (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id = e.id) AS total
         FROM entities e JOIN entries en ON en.entity_id = e.id
        WHERE e.merged_into IS NULL
          AND total >= @minMentions
          AND cited < total * @ratio
        ORDER BY total DESC`
    )
    .all({ minMentions, ratio }) as { id: number; canonical_name: string; cited: number; total: number }[];
}

/** True when a refresh is already queued, so a sweep does not pile up. */
export function refreshInFlight(): boolean {
  const open = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t
        WHERE t.kind IN ('entry', 'plan_entries') AND t.state IN ('pending', 'running')`
    )
    .get() as { n: number };
  return open.n > 0;
}

/**
 * Queues every entry that needs rewriting as its own run. Returns 0 when there
 * is nothing to do, so callers can stay quiet.
 *
 * Capped by the default budget like every other automatic spender. The idle
 * sweep was the one place that created uncapped runs, and it was the one
 * place that needed a cap most.
 */
export function queueStaleEntries(label = "Updating entries"): { runId: number; queued: number } | null {
  const targets = staleEntities();
  if (targets.length === 0) return null;

  return tx(() => {
    const runId = createRun({
      kind: "entry",
      label: `${label} (${targets.length})`,
      budgetCap: getConfig().defaultBudget,
    });
    enqueue(
      runId,
      targets.map((t) => ({ kind: "entry" as const, payload: { entityId: t.id } }))
    );
    return { runId, queued: targets.length };
  });
}
