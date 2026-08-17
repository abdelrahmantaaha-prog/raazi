import { db, tx } from "./db";
import { createRun, enqueue } from "./queue";
import { ENTITY_TYPES } from "./types";

/**
 * Reads a source again — but only the part that has actually been read.
 *
 * "Read again" used to mean the whole book: withdraw every quote the source
 * contributed and queue every passage for extraction. On a 300-page book of
 * which you have read four chapters, that re-spent tokens on two hundred pages
 * nobody had reached, and on a read-along book it did something worse — it
 * extracted the *unread* remainder wholesale, which is precisely what read-along
 * exists to prevent.
 *
 * So the scope now follows `read_passages`, the same record that drives
 * progress and read-along: the passages you have read are withdrawn and
 * re-read, and the rest of the book is not touched — unread passages keep
 * whatever extraction they have (eager books) or none (read-along books), and
 * continue to arrive through the ordinary path as you reach them.
 *
 * Only when nothing at all is on the reading record does this fall back to the
 * whole source — a book you re-extract without ever having opened is asking
 * for the old behaviour, and a partial scope of zero passages would make the
 * button do nothing.
 *
 * Everything else keeps the full version's guarantees, scoped: replaces rather
 * than adds (the withdrawn passages cannot double their quotes), entities left
 * with no evidence anywhere are removed, survivors are marked stale, and the
 * tail — resolve, sweep, context, entries — runs so the second reading is
 * reconciled like a first one.
 */
export function reextractSource(sourceId: number):
  | {
      runId: number;
      scope: "read" | "all";
      chunks: number;
      totalChunks: number;
      removed: number;
      orphaned: number;
      title: string;
    }
  | { error: string } {
  const source = db().prepare("SELECT id, title FROM sources WHERE id=?").get(sourceId) as
    | { id: number; title: string }
    | undefined;
  if (!source) return { error: "No such source." };

  const all = db()
    .prepare("SELECT id FROM chunks WHERE source_id=? ORDER BY seq")
    .all(sourceId) as { id: number }[];
  if (all.length === 0) {
    return { error: "This source has no text yet, so there is nothing to re-read." };
  }

  const read = new Set(
    (
      db().prepare("SELECT chunk_id FROM read_passages WHERE source_id=?").all(sourceId) as {
        chunk_id: number;
      }[]
    ).map((r) => r.chunk_id)
  );

  const scope: "read" | "all" = read.size > 0 ? "read" : "all";
  // Kept in book order: the queue reads the way you did.
  const target = scope === "read" ? all.filter((c) => read.has(c.id)) : all;
  const ids = target.map((c) => c.id);
  const marks = ids.map(() => "?").join(",");

  const result = tx(() => {
    // Who is about to lose evidence — from these passages only — so we can
    // tell afterwards which of them still stand on something.
    const touched = (
      db()
        .prepare(
          `SELECT DISTINCT entity_id FROM mentions WHERE source_id=? AND chunk_id IN (${marks})`
        )
        .all(sourceId, ...ids) as { entity_id: number }[]
    ).map((r) => r.entity_id);

    const removed = (
      db()
        .prepare(`SELECT COUNT(*) AS n FROM mentions WHERE source_id=? AND chunk_id IN (${marks})`)
        .get(sourceId, ...ids) as { n: number }
    ).n;

    // Relations and events hang off their mention; the ones tied to a
    // withdrawn passage go with it. Rows whose mention link is already NULL
    // cannot be traced to a passage, so under a partial scope they stay —
    // deleting them would strip unread chapters that are not being re-read.
    db()
      .prepare(
        `DELETE FROM relations WHERE source_id=? AND mention_id IN
           (SELECT id FROM mentions WHERE source_id=? AND chunk_id IN (${marks}))`
      )
      .run(sourceId, sourceId, ...ids);
    db()
      .prepare(
        `DELETE FROM events WHERE source_id=? AND mention_id IN
           (SELECT id FROM mentions WHERE source_id=? AND chunk_id IN (${marks}))`
      )
      .run(sourceId, sourceId, ...ids);
    if (scope === "all") {
      // Nothing survives a full re-read, including the untraceable rows.
      db().prepare("DELETE FROM relations WHERE source_id=?").run(sourceId);
      db().prepare("DELETE FROM events    WHERE source_id=?").run(sourceId);
    }

    db()
      .prepare(`DELETE FROM mentions WHERE source_id=? AND chunk_id IN (${marks})`)
      .run(sourceId, ...ids);

    let orphaned = 0;
    for (const entityId of touched) {
      const left = (
        db().prepare("SELECT COUNT(*) AS n FROM mentions WHERE entity_id=?").get(entityId) as {
          n: number;
        }
      ).n;
      if (left === 0) {
        // Nothing anywhere supports this entity now. An entry with no evidence
        // is exactly what this app exists to prevent.
        db().prepare("DELETE FROM entities WHERE id=?").run(entityId);
        orphaned++;
      } else {
        db().prepare("UPDATE entities SET entry_state='stale' WHERE id=?").run(entityId);
      }
    }

    // Let these passages be read again — and stamp them queued now, because
    // they are: read-along polls on every scroll tick and must see them as in
    // flight, not as candidates to queue a second time.
    db()
      .prepare(
        `UPDATE chunks SET extracted_at=NULL, skip_reason=NULL, queued_at=datetime('now')
          WHERE id IN (${marks})`
      )
      .run(...ids);

    // A full re-read is the source starting over; a partial one is maintenance
    // on a book you are still reading, and flipping its status would make the
    // shelf report a readable book as busy.
    if (scope === "all") {
      db().prepare("UPDATE sources SET status='extracting' WHERE id=?").run(sourceId);
    }

    const runId = createRun({
      sourceId,
      kind: "reextract",
      label:
        scope === "read"
          ? `Re-reading what you've read of ${source.title}`
          : `Re-reading ${source.title}`,
    });
    enqueue(
      runId,
      target.map((c) => ({ kind: "extract" as const, payload: { chunkId: c.id } }))
    );
    // Names found the second time still need reconciling, the sweep re-finds
    // the appearances extraction walks past, quotes that cannot stand alone
    // get their bearings back, and the entries that cited the old reading are
    // rewritten. The same tail every ingest gets.
    enqueue(
      runId,
      ENTITY_TYPES.map((type) => ({ kind: "resolve" as const, payload: { type } }))
    );
    enqueue(runId, [{ kind: "sweep" as const, payload: { sourceId } }]);
    enqueue(runId, [{ kind: "plan_context" as const, payload: { sourceId } }]);
    enqueue(runId, [{ kind: "plan_entries" as const, payload: {} }]);

    return { runId, removed, orphaned };
  });

  return {
    ...result,
    scope,
    chunks: target.length,
    totalChunks: all.length,
    title: source.title,
  };
}
