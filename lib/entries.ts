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
 */

export interface StaleEntity {
  id: number;
  canonical_name: string;
  mentions: number;
  has_entry: number;
}

/**
 * Entries that are current but incomplete: every mention accounted for in the
 * hash, and a body that cites only a fraction of them.
 *
 * This is a different failure from staleness and was invisible to the old
 * definition. An entry written from 146 passages that cites 52 of them has a
 * matching `built_from_hash` — the evidence *was* all shown to the writer — so
 * it reads as fresh for ever. The count is done in SQL rather than by parsing
 * every body in JavaScript, because this runs on every idle sweep.
 */
const UNDERCOVERED = `
  EXISTS (
    SELECT 1 FROM entries en WHERE en.entity_id = e.id
      AND (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id = e.id) >= 8
      AND (
        SELECT COUNT(*) FROM live_mentions m
         WHERE m.entity_id = e.id
           AND instr(en.body_md, '[[m:' || m.id || ']]') > 0
      ) < (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id = e.id) * @coverage
  )`;

export function staleEntities(
  threshold = getConfig().entryThreshold,
  coverage = 0.85
): StaleEntity[] {
  return db()
    .prepare(
      `SELECT e.id, e.canonical_name,
              (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id = e.id) AS mentions,
              (SELECT COUNT(*) FROM entries en WHERE en.entity_id = e.id) AS has_entry
         FROM entities e
        WHERE e.merged_into IS NULL
          AND (e.entry_state IN ('none', 'stale') OR ${UNDERCOVERED})
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
    .all({ threshold, coverage }) as StaleEntity[];
}

/** How many entries are waiting to be brought up to date. */
export function staleCount(): { total: number; rewrites: number; newEntries: number } {
  const rows = staleEntities();
  const rewrites = rows.filter((r) => r.has_entry > 0).length;
  return { total: rows.length, rewrites, newEntries: rows.length - rewrites };
}

/** True when a refresh is already queued, so a sweep does not pile up. */
export function refreshInFlight(): boolean {
  const open = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t JOIN runs r ON r.id = t.run_id
        WHERE t.kind IN ('entry', 'plan_entries') AND t.state IN ('pending', 'running')`
    )
    .get() as { n: number };
  return open.n > 0;
}

/**
 * Queues every entry that needs rewriting as its own run. Returns 0 when there
 * is nothing to do, so callers can stay quiet.
 */
export function queueStaleEntries(label = "Updating entries"): { runId: number; queued: number } | null {
  const targets = staleEntities();
  if (targets.length === 0) return null;

  return tx(() => {
    const runId = createRun({ kind: "entry", label: `${label} (${targets.length})` });
    enqueue(
      runId,
      targets.map((t) => ({ kind: "entry" as const, payload: { entityId: t.id } }))
    );
    return { runId, queued: targets.length };
  });
}
