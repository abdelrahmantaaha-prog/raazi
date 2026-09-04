import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { finishTask } from "../queue";
import { formatLocator } from "../chunk";
import { normalize } from "../normalize";
import type { Locator, Task } from "../types";

/**
 * Answering a question from the library, and nothing else.
 *
 * The retrieval is deliberately plain — full-text search over the passages and
 * the written entries, widened by entity name. No embeddings: the corpus is
 * small enough that FTS with a decent query beats a vector index, and it stays
 * explainable, which matters when the answer is going into someone's research.
 *
 * The hard rule is the same one the entries follow: every claim carries a
 * citation to a passage that is actually in the library, and anything the
 * library does not cover is said to be uncovered rather than filled in from
 * the model's own knowledge.
 */

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    answer: {
      type: Type.STRING,
      description:
        "The answer in Markdown. Every factual sentence ends with one or more [[m:ID]] markers using the passage IDs supplied.",
    },
    gaps: {
      type: Type.STRING,
      description:
        "What the question asks that these sources do not answer. Empty string if they cover it.",
    },
    followUps: {
      type: Type.ARRAY,
      description: "Two or three questions this material would also answer well.",
      items: { type: Type.STRING },
    },
  },
  required: ["answer", "gaps"],
};

const SYSTEM = `You answer questions using only the passages supplied, for a
researcher who will cite your answer.

Absolute rules:
- Every factual sentence ends with at least one [[m:ID]] marker naming the
  passage it came from. A sentence you cannot cite is one you must not write.
- Use only the supplied passages. You certainly know things about these subjects
  from training; including them would corrupt a body of work that is supposed to
  represent what THESE sources say. Leaving them out is the entire point.
- Where the sources disagree, say so and attribute each side.
- Each passage carries its outlet and publication date. When the question turns
  on what happened when, or on what is most recent, use them and say which
  date a statement belongs to.
- Where they only partly cover the question, answer what they cover and put the
  rest in "gaps". A short honest answer beats a padded one.
- Match the language of the question. If it is asked in Arabic, answer in Arabic.
- Structure a long answer with short Markdown headings. Do not pad.`;

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

export async function handleAsk(task: Task): Promise<void> {
  const { questionId } = JSON.parse(task.payload_json) as { questionId: number };

  const row = db().prepare("SELECT * FROM questions WHERE id=?").get(questionId) as
    | { id: number; question: string; tag_id: number | null }
    | undefined;
  if (!row) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Question is gone.");
    return;
  }

  // The questions table carries no date or source filters yet; they are
  // accepted by retrieve() for callers that have them.
  const passages = retrieve(row.question, row.tag_id ?? undefined);

  if (passages.length === 0) {
    tx(() => {
      db()
        .prepare("UPDATE questions SET state='done', answer_md=?, evidence='[]' WHERE id=?")
        .run(
          "Nothing in the library touches this. Add a source that covers it and ask again.",
          questionId
        );
      finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "done", "No matching passages.");
    });
    return;
  }

  const evidence = passages
    .map(
      (p) =>
        `[[m:${p.id}]] ${p.entity} — ${citationOf(p)}\n   "${p.quote}"${
          p.claim ? `\n   claim: ${p.claim}` : ""
        }`
    )
    .join("\n\n");

  const { data, usage } = await generateJson<{
    answer: string;
    gaps: string;
    followUps?: string[];
  }>({
    stage: "ask",
    system: SYSTEM,
    schema: SCHEMA,
    temperature: 0.2,
    parts: [`QUESTION: ${row.question}\n\nPASSAGES FROM THE LIBRARY:\n${evidence}`],
  });

  // A marker pointing at a passage that was never supplied is a fabrication.
  const valid = new Set(passages.map((p) => p.id));
  const answer = data.answer.replace(/\[\[m:(\d+)\]\]/g, (whole, id) =>
    valid.has(Number(id)) ? whole : ""
  );
  const cited = [...answer.matchAll(/\[\[m:(\d+)\]\]/g)].map((m) => Number(m[1]));

  tx(() => {
    db()
      .prepare(
        `UPDATE questions SET state='done', answer_md=?, evidence=?, tokens_in=?, tokens_out=?
          WHERE id=?`
      )
      .run(
        [answer, data.gaps?.trim() ? `\n\n**Not covered by your sources:** ${data.gaps.trim()}` : ""].join(""),
        // The cited passages are copied in whole, not merely referenced.
        // Re-extracting a source deletes and recreates its mentions, which had
        // already left both existing answers citing passage ids that no longer
        // exist — an answer nobody can check is exactly what this app refuses
        // to produce, and it had been quietly producing them.
        JSON.stringify({
          cited: [...new Set(cited)],
          considered: passages.length,
          followUps: data.followUps ?? [],
          passages: passages
            .filter((p) => cited.includes(p.id))
            .map((p) => ({
              id: p.id,
              quote: p.quote,
              entity: p.entity,
              citation: citationOf(p),
            })),
        }),
        usage.tokensIn,
        usage.tokensOut,
        questionId
      );
    finishTask(task.id, task.run_id, usage, "done", `Answered from ${cited.length} passages.`);
  });
}
