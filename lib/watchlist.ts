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
  /** 'user' if you starred it, 'auto' if it earned its place. */
  source: string;
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

export function watch(opts: {
  entityId?: number;
  tagId?: number;
  phrase?: string;
  note?: string;
  source?: "user" | "auto";
}): number {
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
    // Choosing it by hand overrides an earlier refusal of the same suggestion.
    if (entityId) {
      db().prepare("DELETE FROM watch_dismissed WHERE kind='entity' AND ref_id=?").run(entityId);
    }
    if (tagId) db().prepare("DELETE FROM watch_dismissed WHERE kind='topic' AND ref_id=?").run(tagId);

    return Number(
      db()
        .prepare("INSERT INTO watchlist (entity_id, tag_id, phrase, note, source) VALUES (?, ?, ?, ?, ?)")
        .run(
          entityId ?? null,
          tagId ?? null,
          phrase?.trim() ?? null,
          opts.note?.trim() ?? null,
          opts.source ?? "user"
        )
        .lastInsertRowid
    );
  });
}

/**
 * Takes something off the list — and remembers, if the app put it there.
 *
 * Declining a suggestion has to stick. A subject that earned a suggestion is
 * by definition one that keeps arriving, so without a record the promotion
 * pass would offer it again tomorrow, and the day after, for exactly as long
 * as it stayed in the news. Your own stars are not recorded: removing one is a
 * change of mind about your own decision, not an answer to a question.
 */
export function unwatch(id: number): boolean {
  return tx(() => {
    const row = db().prepare("SELECT entity_id, tag_id, source FROM watchlist WHERE id=?").get(id) as
      | { entity_id: number | null; tag_id: number | null; source: string }
      | undefined;
    if (!row) return false;
    if (row.source === "auto") {
      const kind = row.tag_id !== null ? "topic" : "entity";
      const ref = row.tag_id ?? row.entity_id;
      if (ref !== null) {
        db()
          .prepare("INSERT OR REPLACE INTO watch_dismissed (kind, ref_id) VALUES (?, ?)")
          .run(kind, ref);
      }
    }
    return db().prepare("DELETE FROM watchlist WHERE id=?").run(id).changes > 0;
  });
}

/** How many kept sources a subject has to appear in before it is suggested. */
export const AUTO_WATCH_MIN_SOURCES = 4;

/**
 * And how many different outlets those sources must come from.
 *
 * This is what separates a subject from a masthead. A newspaper's own name is
 * in every piece it publishes and almost nowhere else: on this library
 * "National Public Radio" appeared in nine sources from exactly one outlet,
 * while Iran appeared in eight from eight. Requiring two removes the outlets
 * and the syndication boilerplate without a list of words to ignore — and it
 * says something true besides, that a subject several newsrooms are covering
 * is a subject worth following.
 */
export const AUTO_WATCH_MIN_OUTLETS = 2;

/** How far back that is counted. Long enough to see a story, short enough to
 *  forget last month's. */
export const AUTO_WATCH_DAYS = 21;

/** The most the app will ever have added. A shortlist that is not short is a
 *  list, and the brief already has one of those. */
export const AUTO_WATCH_CAP = 15;

export interface Suggestion {
  tag_id: number;
  name: string;
  sources: number;
  /** How many different outlets carried them. */
  outlets: number;
}

/**
 * What you have been reading about, as topics rather than as names.
 *
 * This was entities for a day and the day was enough. One article about the
 * president produced four watched subjects — Donald Trump, the Trump
 * administration, the White House, the United States — and the brief then
 * printed the same passage under each of them, so a quiet morning read as four
 * developments. Names are how a story is written; topics are what a beat is
 * made of, and "US Politics" says once what those four said four times.
 *
 * Topics also come from somewhere honest: the filing pass already puts every
 * source under the research topics it belongs to, so this counts a judgement
 * the library has already made rather than inventing a second one.
 *
 * Costs nothing — one query, no model.
 */
export function suggestions(limit = AUTO_WATCH_CAP): Suggestion[] {
  return db()
    .prepare(
      `SELECT t.id AS tag_id, t.name,
              COUNT(DISTINCT s.id) AS sources,
              COUNT(DISTINCT s.outlet) AS outlets
         FROM tags t
         JOIN source_tags st ON st.tag_id = t.id
         JOIN sources s ON s.id = st.source_id
        WHERE (s.triage IS NULL OR s.triage = 'kept')
          AND COALESCE(s.kept_at, s.published_at, s.added_at) >= datetime('now', @window)
          AND t.id NOT IN (SELECT tag_id FROM watchlist WHERE tag_id IS NOT NULL)
          AND t.id NOT IN (SELECT ref_id FROM watch_dismissed WHERE kind='topic')
        GROUP BY t.id
       HAVING sources >= @min AND outlets >= @outlets
        ORDER BY sources DESC, t.name
        LIMIT @limit`
    )
    .all({
      window: `-${AUTO_WATCH_DAYS} days`,
      min: AUTO_WATCH_MIN_SOURCES,
      outlets: AUTO_WATCH_MIN_OUTLETS,
      limit,
    }) as Suggestion[];
}

/**
 * Promotes what has earned it, up to the cap, and says what it added.
 *
 * Only ever adds. Nothing is removed for going quiet: a topic you followed
 * through a story is one you will want again when it returns, and a list that
 * empties itself is a list you cannot trust. Run from the morning routine.
 */
export function autoWatch(): Suggestion[] {
  const already = (
    db().prepare("SELECT COUNT(*) AS n FROM watchlist WHERE source='auto'").get() as { n: number }
  ).n;
  const room = AUTO_WATCH_CAP - already;
  if (room <= 0) return [];

  const picks = suggestions(room);
  if (!picks.length) return [];

  return tx(() => {
    const insert = db().prepare(
      "INSERT INTO watchlist (tag_id, source, note) VALUES (?, 'auto', ?)"
    );
    for (const p of picks) {
      insert.run(p.tag_id, `On ${p.sources} of the sources you kept, from ${p.outlets} outlets.`);
    }
    return picks;
  });
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
