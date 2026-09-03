import { db, tx } from "./db";

/**
 * What you are following, and what that changes.
 *
 * A beat is not the whole library. Most of what arrives is background; a few
 * dozen people, institutions and running stories are the reason you opened the
 * reader. The watchlist is that shortlist, and it does three things: it orders
 * the brief, it decides which entries are worth keeping current first, and it
 * is what makes "something happened to X overnight" a question the app can
 * answer without being asked.
 *
 * Deliberately not a filter. Nothing is hidden for being off the list — the
 * pedia stays one shared space, exactly as topics do.
 */

export interface WatchRow {
  id: number;
  entity_id: number | null;
  tag_id: number | null;
  phrase: string | null;
  note: string | null;
  added_at: string;
  label: string;
  kind: "entity" | "topic" | "phrase";
  /** How much has arrived about it since you last looked. */
  recent: number;
}

export function listWatchlist(sinceHours = 24): WatchRow[] {
  return db()
    .prepare(
      `SELECT w.*,
              CASE
                WHEN w.entity_id IS NOT NULL THEN e.canonical_name
                WHEN w.tag_id    IS NOT NULL THEN t.name
                ELSE w.phrase
              END AS label,
              CASE
                WHEN w.entity_id IS NOT NULL THEN 'entity'
                WHEN w.tag_id    IS NOT NULL THEN 'topic'
                ELSE 'phrase'
              END AS kind,
              CASE
                WHEN w.entity_id IS NOT NULL THEN (
                  SELECT COUNT(*) FROM live_mentions m
                    JOIN sources s ON s.id = m.source_id
                   WHERE m.entity_id = w.entity_id
                     AND COALESCE(s.published_at, s.added_at) >= datetime('now', @window))
                WHEN w.tag_id IS NOT NULL THEN (
                  SELECT COUNT(*) FROM sources s
                    JOIN source_tags st ON st.source_id = s.id AND st.tag_id = w.tag_id
                   WHERE COALESCE(s.published_at, s.added_at) >= datetime('now', @window))
                ELSE 0
              END AS recent
         FROM watchlist w
    LEFT JOIN entities e ON e.id = w.entity_id
    LEFT JOIN tags t     ON t.id = w.tag_id
        WHERE (w.entity_id IS NULL OR e.merged_into IS NULL)
        ORDER BY recent DESC, label`
    )
    .all({ window: `-${Math.max(1, sinceHours)} hours` }) as WatchRow[];
}

export function watch(opts: { entityId?: number; tagId?: number; phrase?: string; note?: string }): number {
  const { entityId, tagId, phrase } = opts;
  if (!entityId && !tagId && !phrase?.trim()) {
    throw new Error("Watch an entity, a topic, or a phrase.");
  }
  return tx(() => {
    const existing = db()
      .prepare(
        `SELECT id FROM watchlist
          WHERE (@entityId IS NOT NULL AND entity_id = @entityId)
             OR (@tagId    IS NOT NULL AND tag_id    = @tagId)
             OR (@phrase   IS NOT NULL AND phrase    = @phrase)`
      )
      .get({ entityId: entityId ?? null, tagId: tagId ?? null, phrase: phrase?.trim() ?? null }) as
      | { id: number }
      | undefined;
    if (existing) return existing.id;

    return Number(
      db()
        .prepare("INSERT INTO watchlist (entity_id, tag_id, phrase, note) VALUES (?, ?, ?, ?)")
        .run(entityId ?? null, tagId ?? null, phrase?.trim() ?? null, opts.note?.trim() ?? null)
        .lastInsertRowid
    );
  });
}

export function unwatch(id: number): boolean {
  return db().prepare("DELETE FROM watchlist WHERE id=?").run(id).changes > 0;
}

/** Whether one entity is on the list, for a star button to render itself. */
export function isWatched(entityId: number): boolean {
  return Boolean(db().prepare("SELECT 1 FROM watchlist WHERE entity_id=?").get(entityId));
}

/** The entity ids on the list, for the brief and for entry priority. */
export function watchedEntityIds(): number[] {
  return (
    db().prepare("SELECT entity_id FROM watchlist WHERE entity_id IS NOT NULL").all() as {
      entity_id: number;
    }[]
  ).map((r) => r.entity_id);
}

/**
 * Sources arriving in a window that touch the watchlist, newest first.
 *
 * A phrase watch is answered by full-text search over the passages, an entity
 * watch by its mentions, a topic watch by the source's filing — three
 * different questions with one answer shape, because the brief does not care
 * which kind of watch found a piece.
 */
export function watchHits(sinceIso: string, limit = 200): {
  watch_id: number;
  label: string;
  kind: string;
  source_id: number;
  source_title: string;
  outlet: string | null;
  published_at: string | null;
}[] {
  type Hit = {
    watch_id: number;
    label: string;
    kind: string;
    source_id: number;
    source_title: string;
    outlet: string | null;
    published_at: string | null;
  };
  type Found = Omit<Hit, "watch_id" | "label" | "kind">;

  const out: Hit[] = [];
  const found = (w: WatchRow, rows: Found[]) => {
    for (const r of rows) out.push({ watch_id: w.id, label: w.label, kind: w.kind, ...r });
  };

  for (const w of listWatchlist()) {
    if (w.kind === "entity" && w.entity_id) {
      found(
        w,
        db()
          .prepare(
            `SELECT DISTINCT s.id AS source_id, s.title AS source_title, s.outlet, s.published_at
               FROM live_mentions m JOIN sources s ON s.id = m.source_id
              WHERE m.entity_id = ? AND COALESCE(s.published_at, s.added_at) >= ?
              ORDER BY COALESCE(s.published_at, s.added_at) DESC LIMIT ?`
          )
          .all(w.entity_id, sinceIso, limit) as Found[]
      );
    } else if (w.kind === "topic" && w.tag_id) {
      found(
        w,
        db()
          .prepare(
            `SELECT s.id AS source_id, s.title AS source_title, s.outlet, s.published_at
               FROM sources s JOIN source_tags st ON st.source_id = s.id AND st.tag_id = ?
              WHERE COALESCE(s.published_at, s.added_at) >= ?
              ORDER BY COALESCE(s.published_at, s.added_at) DESC LIMIT ?`
          )
          .all(w.tag_id, sinceIso, limit) as Found[]
      );
    } else if (w.phrase) {
      try {
        found(
          w,
          db()
            .prepare(
              `SELECT DISTINCT s.id AS source_id, s.title AS source_title, s.outlet, s.published_at
                 FROM chunks_fts f
                 JOIN chunks c ON c.id = f.rowid
                 JOIN sources s ON s.id = c.source_id
                WHERE chunks_fts MATCH ? AND COALESCE(s.published_at, s.added_at) >= ?
                ORDER BY COALESCE(s.published_at, s.added_at) DESC LIMIT ?`
            )
            .all(`"${w.phrase.replace(/"/g, "")}"`, sinceIso, limit) as Found[]
        );
      } catch {
        // A phrase the full-text index cannot parse is not worth failing over.
      }
    }
  }
  return out;
}
