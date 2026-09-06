import { db } from "./db";
import { formatLocator } from "./chunk";
import { normalize } from "./normalize";
import type { Locator } from "./types";

/**
 * Finding the passages that bear on a question.
 *
 * This was the first half of the Ask feature. Ask itself is gone — a question
 * put to the whole library cost a premium call every time and was usually
 * answered better by reading the entry — but retrieval is not about answering
 * anything. It is a search over evidence, scored by entity, phrase and
 * recency, and the fact-checker still needs exactly that: for each claim in a
 * draft, the passages that speak to it.
 */

export interface Passage {
  id: number;
  quote: string;
  claim: string | null;
  entity: string;
  source: string;
  author: string | null;
  outlet: string | null;
  /** ISO datetime, a bare year, or null. */
  published: string | null;
  locator: string;
}

/** Narrowing a search by date or by source. Dates are ISO, inclusive. */
export interface RetrieveFilters {
  since?: string;
  until?: string;
  sourceIds?: number[];
}

/** Passages any one entity may contribute, so a big one cannot fill the budget. */
const PER_ENTITY = 15;

/**
 * The words a question is searched by.
 *
 * Anything under three letters used to be dropped, which on a North America
 * beat removed the subject: "US Canada trade dispute" was searched as "Canada
 * trade dispute". A two-letter term now survives when it is written in
 * capitals — US, UN, EU, UK, AI are names, not noise — or when the question is
 * short enough that every word is load-bearing.
 */
export function queryTerms(question: string): string[] {
  const tokens = question
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const short = tokens.length <= 4;
  const shouted = (t: string) => t === t.toUpperCase() && /\p{Lu}/u.test(t);
  return tokens.filter(
    (t) => !STOP.has(t.toLowerCase()) && (t.length > 2 || (t.length === 2 && (short || shouted(t))))
  );
}

/**
 * Finds what the library has on a question.
 *
 * Three passes, because each catches what the others miss: the phrase itself,
 * its individual terms, and any entity whose name appears in the question —
 * "Israeli settlements" should reach an entity called "settlements" even where
 * that exact phrase never occurs in a passage.
 */
export function retrieve(
  question: string,
  tagId?: number,
  limit = 60,
  filters: RetrieveFilters = {}
): Passage[] {
  const terms = queryTerms(question);
  if (!terms.length) return [];

  const found = new Map<number, Passage>();
  const collect = (rows: Passage[]) => {
    for (const r of rows) if (!found.has(r.id)) found.set(r.id, r);
  };

  // Every narrowing clause, with its parameters, in one place so the three
  // passes cannot drift apart. Source ids are integers and inlined; the rest
  // are bound.
  const clauses: string[] = [];
  const bound: Record<string, unknown> = { limit };
  if (tagId) {
    clauses.push("EXISTS (SELECT 1 FROM source_tags st WHERE st.source_id=m.source_id AND st.tag_id=@tagId)");
    bound.tagId = tagId;
  }
  const since = isoDay(filters.since);
  if (since) {
    clauses.push("substr(COALESCE(s.published_at, s.year), 1, 10) >= @since");
    bound.since = since;
  }
  const until = isoDay(filters.until);
  if (until) {
    clauses.push("substr(COALESCE(s.published_at, s.year), 1, 10) <= @until");
    bound.until = until;
  }
  const sourceIds = (filters.sourceIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (sourceIds.length) clauses.push(`m.source_id IN (${sourceIds.join(",")})`);
  const narrow = clauses.map((c) => `AND ${c}`).join("\n       ");

  const columns = `m.id, m.quote, m.claim, e.canonical_name AS entity,
           s.title AS source, s.author, s.outlet,
           COALESCE(s.published_at, s.year) AS published,
           c.locator_json, d.label AS doc_label`;

  /**
   * Ranked by the full-text index rather than by row order.
   *
   * The rank used to be computed inside a subquery and then thrown away by the
   * outer select, so the sixty passages handed to the model were sixty
   * arbitrary matches rather than the sixty best ones. Joining the ranked list
   * keeps the order all the way out.
   */
  const ranked = `
    WITH hits AS (
      SELECT rowid AS chunk_id, rank FROM chunks_fts
       WHERE chunks_fts MATCH @match ORDER BY rank LIMIT 200
    )
    SELECT ${columns}
      FROM hits
      JOIN live_mentions m ON m.chunk_id = hits.chunk_id
      JOIN entities e ON e.id = m.entity_id
      JOIN sources  s ON s.id = m.source_id
      JOIN chunks   c ON c.id = m.chunk_id
 LEFT JOIN documents d ON d.id = c.doc_id
     WHERE e.merged_into IS NULL
       ${narrow}
     ORDER BY hits.rank
     LIMIT @limit`;

  const hydrate = (rows: (Omit<Passage, "locator"> & { locator_json: string; doc_label: string | null })[]) =>
    rows.map(({ locator_json, doc_label, ...r }) => ({
      ...r,
      locator: formatLocator(JSON.parse(locator_json) as Locator, doc_label),
    }));

  const orMatch = terms.map((t) => `"${t}"`).join(" OR ");

  // 1. Passages whose chunk matches the question as a phrase, then as terms.
  for (const match of [terms.map((t) => `"${t}"`).join(" "), orMatch]) {
    try {
      const rows = db().prepare(ranked).all({ ...bound, match }) as never[];
      collect(hydrate(rows));
    } catch {
      // A term FTS cannot parse is not worth failing the whole question over.
    }
    if (found.size >= limit) break;
  }

  // 2. Anything attached to an entity the question names.
  //
  // Within an entity, passages are ranked by how well their chunk matches the
  // question, then by how recent their source is — not by how big the entity
  // is. Ordering by the entity's mention count let "United States" fill the
  // whole budget with its earliest quotes whatever was asked; a per-entity cap
  // leaves room for the other names in the question.
  if (found.size < limit) {
    const norms = new Set<string>();
    for (let n = 3; n >= 1; n--) {
      for (let i = 0; i + n <= terms.length; i++) {
        norms.add(normalize(terms.slice(i, i + n).join(" ")));
      }
    }
    const ids = [...norms].filter(Boolean).slice(0, 40);
    if (ids.length) {
      const names: Record<string, string> = {};
      ids.forEach((id, i) => (names[`n${i}`] = id));
      const holes = ids.map((_, i) => `@n${i}`).join(",");

      const byEntity = (hitsCte: string) => `
        WITH hits AS (${hitsCte}),
        cand AS (
          SELECT ${columns}, h.rank AS rank,
                 ROW_NUMBER() OVER (
                   PARTITION BY e.id
                   ORDER BY (h.rank IS NULL), h.rank,
                            (COALESCE(s.published_at, s.year) IS NULL),
                            COALESCE(s.published_at, s.year) DESC, m.id
                 ) AS rn
            FROM live_mentions m
            JOIN entities e ON e.id = m.entity_id
            JOIN sources  s ON s.id = m.source_id
            JOIN chunks   c ON c.id = m.chunk_id
       LEFT JOIN documents d ON d.id = c.doc_id
       LEFT JOIN hits h ON h.chunk_id = m.chunk_id
           WHERE e.merged_into IS NULL
             AND (e.normalized IN (${holes})
               OR EXISTS (SELECT 1 FROM aliases a WHERE a.entity_id=e.id AND a.normalized IN (${holes})))
             ${narrow}
        )
        SELECT * FROM cand
         WHERE rn <= @perEntity
         ORDER BY (rank IS NULL), rank, (published IS NULL), published DESC, id
         LIMIT @limit`;

      const params = { ...bound, ...names, perEntity: PER_ENTITY, limit: limit - found.size };
      let rows: never[] = [];
      try {
        rows = db()
          .prepare(byEntity("SELECT rowid AS chunk_id, rank FROM chunks_fts WHERE chunks_fts MATCH @match"))
          .all({ ...params, match: orMatch }) as never[];
      } catch {
        // If the FTS query will not parse, rank by recency alone rather than
        // lose the entity pass altogether.
        rows = db()
          .prepare(byEntity("SELECT NULL AS chunk_id, NULL AS rank WHERE 0"))
          .all(params) as never[];
      }
      collect(hydrate(rows));
    }
  }

  return [...found.values()].slice(0, limit);
}

/** The first ten characters of an ISO date, or null for anything else. */
function isoDay(s?: string): string | null {
  if (!s) return null;
  const m = /^(\d{4}(?:-\d{2}(?:-\d{2})?)?)/.exec(s.trim());
  return m ? m[1] : null;
}

const STOP = new Set([
  "the", "and", "for", "with", "what", "who", "how", "why", "when", "where", "was", "were",
  "are", "did", "does", "you", "know", "tell", "everything", "about", "from", "into", "that",
  "this", "these", "those", "there", "their", "them", "have", "has", "had", "can", "all",
  "any", "give", "show", "explain", "describe", "list",
]);

/** "The Globe and Mail, Jane Doe, 2026-09-01, p. 4" — what a reader needs to find it. */
export function citationOf(p: Passage): string {
  return [p.outlet, p.author, p.published?.slice(0, 10), p.source, p.locator].filter(Boolean).join(", ");
}
