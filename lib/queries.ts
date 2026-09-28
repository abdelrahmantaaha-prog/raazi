import { db } from "./db";
import { formatCitation } from "./citation";
import { formatLocator } from "./chunk";
import { tagFilterSql, tagsForEntity } from "./tags";
import { quoteKeyOf } from "./audit";
import type { EntityType, Locator } from "./types";

/** Read-side helpers shared by the API routes and the server components. */

export interface EntityRow {
  id: number;
  type: EntityType;
  canonical_name: string;
  disambiguator: string | null;
  entry_state: "none" | "stale" | "fresh";
  starred: number;
  mentions: number;
  sources: number;
  summary: string | null;
}

export function listEntities(opts: {
  type?: EntityType | "all";
  q?: string;
  sourceId?: number;
  tagId?: number;
  limit?: number;
} = {}): EntityRow[] {
  const where: string[] = ["e.merged_into IS NULL"];
  const params: Record<string, unknown> = { limit: opts.limit ?? 500 };

  if (opts.type && opts.type !== "all") {
    where.push("e.type = @type");
    params.type = opts.type;
  }
  if (opts.q?.trim()) {
    where.push(
      "(e.canonical_name LIKE @q OR EXISTS (SELECT 1 FROM aliases a WHERE a.entity_id=e.id AND a.surface LIKE @q))"
    );
    params.q = `%${opts.q.trim()}%`;
  }
  if (opts.sourceId) {
    where.push("EXISTS (SELECT 1 FROM live_mentions m WHERE m.entity_id=e.id AND m.source_id=@sourceId)");
    params.sourceId = opts.sourceId;
  }
  if (opts.tagId) {
    where.push(tagFilterSql("e"));
    params.tagId = opts.tagId;
  }

  return db()
    .prepare(
      `SELECT e.id, e.type, e.canonical_name, e.disambiguator, e.entry_state, e.starred,
              (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id=e.id) AS mentions,
              (SELECT COUNT(DISTINCT m.source_id) FROM live_mentions m WHERE m.entity_id=e.id) AS sources,
              (SELECT en.summary FROM entries en WHERE en.entity_id=e.id) AS summary
         FROM entities e
        WHERE ${where.join(" AND ")}
        ORDER BY e.starred DESC, mentions DESC, e.canonical_name
        LIMIT @limit`
    )
    .all(params) as EntityRow[];
}

export function typeCounts(tagId?: number): Record<string, number> {
  const rows = db()
    .prepare(
      `SELECT e.type, COUNT(*) AS n FROM entities e
        WHERE e.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM live_mentions m WHERE m.entity_id = e.id)
          ${tagId ? `AND ${tagFilterSql("e")}` : ""}
        GROUP BY e.type`
    )
    .all(tagId ? { tagId } : {}) as { type: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.type, r.n]));
}

declare global {
  // eslint-disable-next-line no-var
  var __corpusWords: Map<number, { key: string; words: number }> | undefined;
}

/**
 * Each source's rough word count, keyed by source id.
 *
 * Counting words means measuring the text of every chunk, and SQLite reads a
 * whole value to count its characters: across the library that is every page
 * of it, about a second from a cold disk, and the Library asked for it every
 * 1.5 seconds while the worker ran. A memory-starved machine had it from disk
 * each time, on the thread that answers everything else, and the windows put
 * up "The Corpus server is down".
 *
 * Chunk text is never edited in place — a source is re-chunked into new rows —
 * so a source's count stays true until its number of chunks or its newest
 * chunk id moves. Both come from the index, so only a changed source is
 * measured again.
 */
export function wordsBySource(): Map<number, number> {
  const cache = (globalThis.__corpusWords ??= new Map());
  const shape = db()
    .prepare(
      `SELECT source_id AS id, COUNT(*) || ':' || MAX(id) AS key
         FROM chunks GROUP BY source_id`
    )
    .all() as { id: number; key: string }[];
  const measure = db().prepare(
    `SELECT COALESCE(SUM(LENGTH(text)), 0) / 6 AS words FROM chunks WHERE source_id = ?`
  );
  const out = new Map<number, number>();
  for (const s of shape) {
    let hit = cache.get(s.id);
    if (!hit || hit.key !== s.key) {
      hit = { key: s.key, words: (measure.get(s.id) as { words: number }).words };
      cache.set(s.id, hit);
    }
    out.set(s.id, hit.words);
  }
  for (const id of cache.keys()) if (!out.has(id)) cache.delete(id);
  return out;
}

export interface EvidenceRow {
  id: number;
  quote: string;
  claim: string | null;
  /** What a back-reference in the quote points at. See lib/pipeline/extract.ts. */
  context: string | null;
  /** Below 1 when the passage never named the subject and context supplied it. */
  confidence: number;
  surface: string;
  starred: number;
  source_id: number;
  source_title: string;
  source_author: string | null;
  source_year: string | null;
  source_publisher: string | null;
  chunk_id: number;
  locator: string;
}

export function evidenceFor(entityId: number): EvidenceRow[] {
  const rows = db()
    .prepare(
      `SELECT m.id, m.quote, m.claim, m.context, m.confidence, m.surface, m.starred,
              m.source_id, m.chunk_id,
              s.title AS source_title, s.author AS source_author,
              s.year AS source_year, s.publisher AS source_publisher,
              c.locator_json, d.label AS doc_label
         FROM live_mentions m
         JOIN sources s ON s.id = m.source_id
         JOIN chunks  c ON c.id = m.chunk_id
    LEFT JOIN documents d ON d.id = c.doc_id
        WHERE m.entity_id = ?
        ORDER BY s.id, m.id`
    )
    .all(entityId) as (Omit<EvidenceRow, "locator"> & { locator_json: string; doc_label: string | null })[];

  return rows.map((r) => ({
    ...r,
    locator: formatLocator(JSON.parse(r.locator_json) as Locator, r.doc_label),
  }));
}

/** "Heikal, Autumn of Fury, p. 142" — what a citation renders to. */
export function citationOf(e: {
  source_author: string | null;
  source_title: string;
  source_year: string | null;
  locator: string;
}): string {
  return formatCitation({
    author: e.source_author,
    title: e.source_title,
    year: e.source_year,
    locator: e.locator,
  });
}

export function entityDetail(id: number) {
  // Named columns rather than *: the row carries an `embedding` blob, and
  // SELECT * shipped it to the browser on every entity page — kilobytes of
  // binary that the client has no use for, and that React warns about.
  const entity = db()
    .prepare(
      `SELECT id, type, canonical_name, disambiguator, entry_state, starred, merged_into,
              name_locked
         FROM entities WHERE id=?`
    )
    .get(id) as
    | {
        id: number;
        type: EntityType;
        canonical_name: string;
        disambiguator: string | null;
        entry_state: string;
        starred: number;
        name_locked: number;
        merged_into: number | null;
      }
    | undefined;
  if (!entity) return undefined;

  const entry = db().prepare("SELECT * FROM entries WHERE entity_id=?").get(id) as
    | { summary: string; body_md: string; updated_at: string; model: string | null }
    | undefined;

  const evidence = evidenceFor(id);

  const aliases = (
    db().prepare("SELECT surface FROM aliases WHERE entity_id=? ORDER BY surface").all(id) as {
      surface: string;
    }[]
  ).map((a) => a.surface);

  const events = db()
    .prepare(
      `SELECT ev.*, s.title AS source_title FROM events ev
    LEFT JOIN sources s ON s.id = ev.source_id
        WHERE ev.entity_id=?
        ORDER BY COALESCE(ev.date_iso, 'zzz'), ev.id`
    )
    .all(id) as {
    id: number;
    date_text: string | null;
    date_iso: string | null;
    summary: string;
    source_title: string | null;
    mention_id: number | null;
  }[];

  const relations = db()
    .prepare(
      `SELECT r.id, r.type, r.quote,
              CASE WHEN r.from_entity=? THEN 'out' ELSE 'in' END AS direction,
              other.id AS other_id, other.canonical_name AS other_name, other.type AS other_type,
              (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id = other.id) AS other_weight
         FROM relations r
         JOIN entities other
           ON other.id = CASE WHEN r.from_entity=? THEN r.to_entity ELSE r.from_entity END
        WHERE (r.from_entity=? OR r.to_entity=?) AND other.merged_into IS NULL
        ORDER BY other.canonical_name`
    )
    .all(id, id, id, id) as {
    id: number;
    type: string;
    quote: string | null;
    direction: "in" | "out";
    other_id: number;
    other_name: string;
    other_type: EntityType;
    other_weight: number;
  }[];

  /**
   * Ties *between* this entity's neighbours. A star of spokes only says who
   * someone knows; these are what make it a network — that two of their
   * associates are father and son, or suing each other, is often the point.
   */
  const network =
    relations.length === 0
      ? []
      : (db()
          .prepare(
            `SELECT r.id, r.type, r.quote, r.from_entity AS a, r.to_entity AS b
               FROM relations r
              WHERE r.from_entity IN (SELECT value FROM json_each(?))
                AND r.to_entity   IN (SELECT value FROM json_each(?))
                AND r.from_entity <> r.to_entity`
          )
          .all(
            JSON.stringify([...new Set(relations.map((r) => r.other_id))]),
            JSON.stringify([...new Set(relations.map((r) => r.other_id))])
          ) as { id: number; type: string; quote: string | null; a: number; b: number }[]);

  const revisions = db()
    .prepare(
      `SELECT rv.id, rv.changelog_md, rv.created_at, rv.model, s.title AS trigger_title
         FROM entry_revisions rv
    LEFT JOIN sources s ON s.id = rv.trigger_source_id
        WHERE rv.entity_id=? ORDER BY rv.id DESC`
    )
    .all(id) as {
    id: number;
    changelog_md: string | null;
    created_at: string;
    model: string | null;
    trigger_title: string | null;
  }[];

  const contradictions = db()
    .prepare(
      `SELECT c.*, sa.title AS title_a, sb.title AS title_b
         FROM contradictions c
    LEFT JOIN sources sa ON sa.id=c.source_a
    LEFT JOIN sources sb ON sb.id=c.source_b
        WHERE c.entity_id=? ORDER BY c.resolved, c.id DESC`
    )
    .all(id) as {
    id: number;
    claim_a: string;
    claim_b: string;
    quote_b: string | null;
    title_a: string | null;
    title_b: string | null;
    resolved: number;
  }[];

  const merges = db()
    .prepare(
      "SELECT * FROM merge_log WHERE kept_entity=? AND undone=0 ORDER BY id DESC"
    )
    .all(id) as {
    id: number;
    merged_name: string;
    reason: string | null;
    actor: string;
    created_at: string;
  }[];

  const bySource = new Map<number, EvidenceRow[]>();
  for (const e of evidence) {
    if (!bySource.has(e.source_id)) bySource.set(e.source_id, []);
    bySource.get(e.source_id)!.push(e);
  }

  return {
    entity,
    entry,
    tags: tagsForEntity(id),
    evidence,
    evidenceBySource: [...bySource.entries()].map(([sourceId, rows]) => ({
      sourceId,
      title: rows[0].source_title,
      author: rows[0].source_author,
      rows,
    })),
    aliases,
    events,
    relations,
    network,
    revisions,
    contradictions,
    merges,
    // What you rejected, kept where you can see and undo it. Evidence that
    // vanished when you threw it out would make the audit unauditable.
    discarded: discardedFor(id),
    // Sentences the verify pass could not square with their own citations.
    // Computed and stored after every entry write; an entry page that hid them
    // would be paying for the check and burying the answer.
    flags: db()
      .prepare(
        "SELECT id, sentence, verdict, note, mention_ids FROM entry_flags WHERE entity_id=? ORDER BY id"
      )
      .all(id) as {
      id: number;
      sentence: string;
      verdict: string;
      note: string | null;
      mention_ids: string;
    }[],
  };
}

export interface DiscardedRow extends EvidenceRow {
  discard_reason: string;
  discarded_at: string;
  /** Your own words, from the ledger. Null when you gave only a category. */
  note: string | null;
  scope: string;
  discard_id: number | null;
}

/**
 * The passages you threw out of this entry.
 *
 * Read straight from `mentions` rather than through `live_mentions` — the one
 * query in the app that should see them.
 *
 * The reason and your note live in the ledger, because they have to outlive the
 * row; they are matched back on in JavaScript rather than joined in SQL. That is
 * not fussiness. The ledger's key collapses runs of whitespace, and no
 * combination of SQLite's `trim` and `replace` does the same, so a quote
 * re-extracted with its line breaks folded differently would join to nothing and
 * silently lose the reason you gave.
 */
export function discardedFor(entityId: number): DiscardedRow[] {
  const rows = db()
    .prepare(
      `SELECT m.id, m.quote, m.claim, m.context, m.confidence, m.surface, m.starred,
              m.source_id, m.chunk_id, m.discard_reason, m.discarded_at,
              s.title AS source_title, s.author AS source_author,
              s.year AS source_year, s.publisher AS source_publisher,
              c.locator_json, d.label AS doc_label
         FROM mentions m
         JOIN sources s ON s.id = m.source_id
         JOIN chunks  c ON c.id = m.chunk_id
    LEFT JOIN documents d ON d.id = c.doc_id
        WHERE m.entity_id = ? AND m.discarded_at IS NOT NULL
        ORDER BY m.discarded_at DESC, m.id`
    )
    .all(entityId) as (Omit<DiscardedRow, "locator" | "note" | "scope" | "discard_id"> & {
    locator_json: string;
    doc_label: string | null;
  })[];

  const ledger = new Map<string, { id: number; note: string | null; scope: string }>();
  for (const d of db()
    .prepare(
      `SELECT id, quote_key, note, scope FROM evidence_discards
        WHERE entity_norm = (SELECT normalized FROM entities WHERE id = ?)`
    )
    .all(entityId) as { id: number; quote_key: string; note: string | null; scope: string }[]) {
    ledger.set(d.quote_key, { id: d.id, note: d.note, scope: d.scope });
  }

  return rows.map((r) => {
    const verdict = ledger.get(quoteKeyOf(r.quote));
    return {
      ...r,
      locator: formatLocator(JSON.parse(r.locator_json) as Locator, r.doc_label),
      discard_id: verdict?.id ?? null,
      note: verdict?.note ?? null,
      scope: verdict?.scope ?? "entity",
    };
  });
}

export type EntityDetail = NonNullable<ReturnType<typeof entityDetail>>;

/** FTS over the raw text and the written entries at once. */
export function search(q: string, opts: { tagId?: number; limit?: number } = {}) {
  const limit = opts.limit ?? 40;
  const query = q.trim();
  if (!query) return { chunks: [], entries: [] };
  const match = query
    .split(/\s+/)
    .map((t) => `"${t.replace(/"/g, "")}"`)
    .join(" ");

  const chunks = db()
    .prepare(
      `SELECT c.id, c.source_id, s.title AS source_title, d.label AS doc_label,
              c.locator_json,
              snippet(chunks_fts, 0, '<<', '>>', ' … ', 24) AS snippet
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         JOIN sources s ON s.id = c.source_id
    LEFT JOIN documents d ON d.id = c.doc_id
        WHERE chunks_fts MATCH @match
          ${opts.tagId ? "AND EXISTS (SELECT 1 FROM source_tags st WHERE st.source_id=s.id AND st.tag_id=@tagId)" : ""}
        ORDER BY rank LIMIT @limit`
    )
    .all({ match, limit, ...(opts.tagId ? { tagId: opts.tagId } : {}) }) as {
    id: number;
    source_id: number;
    source_title: string;
    doc_label: string | null;
    locator_json: string;
    snippet: string;
  }[];

  const entries = db()
    .prepare(
      `SELECT e.id, e.canonical_name, e.type,
              snippet(entries_fts, 1, '<<', '>>', ' … ', 24) AS snippet
         FROM entries_fts
         JOIN entities e ON e.id = entries_fts.rowid
        WHERE entries_fts MATCH @match AND e.merged_into IS NULL
          ${opts.tagId ? `AND ${tagFilterSql("e")}` : ""}
        ORDER BY rank LIMIT @limit`
    )
    .all({ match, limit, ...(opts.tagId ? { tagId: opts.tagId } : {}) }) as {
    id: number;
    canonical_name: string;
    type: EntityType;
    snippet: string;
  }[];

  return {
    chunks: chunks.map((c) => {
      const locator = formatLocator(JSON.parse(c.locator_json) as Locator, c.doc_label);
      return {
        ...c,
        // A single-section source labels its only chunk with the source title;
        // showing both reads as a stutter.
        locator: locator === c.source_title ? "" : locator,
      };
    }),
    // Citation markers are machinery, not prose — they have no place in a snippet.
    entries: entries.map((e) => ({ ...e, snippet: e.snippet.replace(/\[\[m:\d+\]\]/g, "") })),
  };
}
