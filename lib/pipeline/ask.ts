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
- Where they only partly cover the question, answer what they cover and put the
  rest in "gaps". A short honest answer beats a padded one.
- Match the language of the question. If it is asked in Arabic, answer in Arabic.
- Structure a long answer with short Markdown headings. Do not pad.`;

interface Passage {
  id: number;
  quote: string;
  claim: string | null;
  entity: string;
  source: string;
  author: string | null;
  locator: string;
}

/**
 * Finds what the library has on a question.
 *
 * Three passes, because each catches what the others miss: the phrase itself,
 * its individual terms, and any entity whose name appears in the question —
 * "Israeli settlements" should reach an entity called "settlements" even where
 * that exact phrase never occurs in a passage.
 */
export function retrieve(question: string, tagId?: number, limit = 60): Passage[] {
  const terms = question
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t.toLowerCase()));
  if (!terms.length) return [];

  const found = new Map<number, Passage>();
  const tagClause = tagId
    ? "AND EXISTS (SELECT 1 FROM source_tags st WHERE st.source_id=m.source_id AND st.tag_id=@tagId)"
    : "";

  const collect = (rows: Passage[]) => {
    for (const r of rows) if (!found.has(r.id)) found.set(r.id, r);
  };

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
    SELECT m.id, m.quote, m.claim, e.canonical_name AS entity,
           s.title AS source, s.author, c.locator_json, d.label AS doc_label
      FROM hits
      JOIN live_mentions m ON m.chunk_id = hits.chunk_id
      JOIN entities e ON e.id = m.entity_id
      JOIN sources  s ON s.id = m.source_id
      JOIN chunks   c ON c.id = m.chunk_id
 LEFT JOIN documents d ON d.id = c.doc_id
     WHERE e.merged_into IS NULL ${tagClause}
     ORDER BY hits.rank
     LIMIT @limit`;

  const hydrate = (rows: (Omit<Passage, "locator"> & { locator_json: string; doc_label: string | null })[]) =>
    rows.map((r) => ({
      ...r,
      locator: formatLocator(JSON.parse(r.locator_json) as Locator, r.doc_label),
    }));

  // 1. Passages whose chunk matches the question as a phrase, then as terms.
  for (const match of [
    terms.map((t) => `"${t}"`).join(" "),
    terms.map((t) => `"${t}"`).join(" OR "),
  ]) {
    try {
      const rows = db()
        .prepare(ranked)
        .all({ match, limit, ...(tagId ? { tagId } : {}) }) as never[];
      collect(hydrate(rows));
    } catch {
      // A term FTS cannot parse is not worth failing the whole question over.
    }
    if (found.size >= limit) break;
  }

  // 2. Anything attached to an entity the question names.
  if (found.size < limit) {
    const norms = new Set<string>();
    for (let n = 3; n >= 1; n--) {
      for (let i = 0; i + n <= terms.length; i++) {
        norms.add(normalize(terms.slice(i, i + n).join(" ")));
      }
    }
    const ids = [...norms].filter(Boolean).slice(0, 40);
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      const rows = db()
        .prepare(
          `SELECT m.id, m.quote, m.claim, e.canonical_name AS entity,
                  s.title AS source, s.author, c.locator_json, d.label AS doc_label
             FROM live_mentions m
             JOIN entities e ON e.id = m.entity_id
             JOIN sources  s ON s.id = m.source_id
             JOIN chunks   c ON c.id = m.chunk_id
        LEFT JOIN documents d ON d.id = c.doc_id
            WHERE e.merged_into IS NULL
              AND (e.normalized IN (${placeholders})
                OR EXISTS (SELECT 1 FROM aliases a WHERE a.entity_id=e.id AND a.normalized IN (${placeholders})))
              ${tagId ? "AND EXISTS (SELECT 1 FROM source_tags st WHERE st.source_id=m.source_id AND st.tag_id=?)" : ""}
            -- Best-documented entities first, so a name the library barely
            -- mentions does not crowd out one it covers at length.
            ORDER BY (SELECT COUNT(*) FROM live_mentions mm WHERE mm.entity_id = e.id) DESC, m.id
            LIMIT ?`
        )
        .all(...ids, ...ids, ...(tagId ? [tagId] : []), limit) as never[];
      collect(hydrate(rows));
    }
  }

  return [...found.values()].slice(0, limit);
}

const STOP = new Set([
  "the", "and", "for", "with", "что", "what", "who", "how", "why", "when", "where", "was", "were",
  "are", "did", "does", "you", "know", "tell", "everything", "about", "from", "into", "that",
  "this", "these", "those", "there", "their", "them", "have", "has", "had", "can", "all",
  "any", "give", "show", "explain", "describe", "list",
]);

export async function handleAsk(task: Task): Promise<void> {
  const { questionId } = JSON.parse(task.payload_json) as { questionId: number };

  const row = db().prepare("SELECT * FROM questions WHERE id=?").get(questionId) as
    | { id: number; question: string; tag_id: number | null }
    | undefined;
  if (!row) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Question is gone.");
    return;
  }

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
        `[[m:${p.id}]] ${p.entity} — ${[p.author, p.source, p.locator].filter(Boolean).join(", ")}\n   "${p.quote}"${
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
    sample: passages
      .slice(0, 8)
      .map((p) => p.quote)
      .join(" ")
      .slice(0, 600),
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
              citation: [p.author, p.source, p.locator].filter(Boolean).join(", "),
            })),
        }),
        usage.tokensIn,
        usage.tokensOut,
        questionId
      );
    finishTask(task.id, task.run_id, usage, "done", `Answered from ${cited.length} passages.`);
  });
}
