import { Type, type Schema } from "@google/genai";
import { db } from "./db";
import { generateJson } from "./ai/client";
import { hasUsableKey } from "./keys";
import { formatLocator } from "./chunk";
import { ftsMatch, queryWords } from "./fts";
import { isJunkText } from "./junk-text";
import type { Found } from "./meaning-search";
import type { Locator } from "./types";

/**
 * Asking the library a question with no meaning search to hand.
 *
 * Search by meaning needs every passage and the question turned into vectors,
 * and only Gemini makes those here — Claude has no such service. With the work
 * routed to Claude and no Gemini key, Ask simply failed. So when meaning
 * search cannot run, Claude does the searching a researcher would: it turns
 * the question into several searches (other wordings, names, the other
 * language), the library's own word index runs them, and Claude then reads the
 * candidates and picks the passages that bear on the question, best first.
 *
 * What comes back is the same as ever: passages that are in the library,
 * opened at their place in the source. Claude chooses among them and writes
 * nothing; a passage it names that was not among the candidates is ignored.
 */

/** Whether the meaning search can run at all: a usable Gemini key makes the vectors. */
export function canEmbed(): boolean {
  return hasUsableKey("gemini");
}

const QUERIES: Schema = {
  type: Type.OBJECT,
  properties: {
    queries: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Three to six short searches, two to five words each.",
    },
  },
  required: ["queries"],
};

const QUERIES_SYSTEM = `You turn a researcher's question into searches of their
private library, which matches words, not meaning. Write three to six short
searches, two to five words each, that the passages answering the question are
likely to contain: the names, places, organisations, figures and terms involved,
other wordings of the idea, and the same searches in Arabic if the question is
in English, or in English if it is in Arabic. No quotation marks, no operators.`;

const PICK: Schema = {
  type: Type.OBJECT,
  properties: {
    picks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          n: { type: Type.INTEGER, description: "The passage's number." },
          fit: { type: Type.STRING, enum: ["close", "related", "loose"] },
        },
        required: ["n", "fit"],
      },
    },
  },
  required: ["picks"],
};

const PICK_SYSTEM = `You choose, from numbered passages of a researcher's
library, the ones that bear on their question, best first. You do not answer
the question or summarise anything.

- close: the passage speaks directly to the question.
- related: it bears on it, or on part of it.
- loose: only touches it. Leave out passages that do not bear on it at all.
Use only the numbers given.`;

/** Candidates per search, and in all. */
const PER_QUERY = 25;
const CANDIDATES = 60;
const SHOWN_CHARS = 700;

export async function askWithReader(
  question: string,
  opts: { limit?: number; sourceId?: number } = {}
): Promise<Found[]> {
  const q = question.trim();
  if (!q) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 60));

  let queries: string[] = [q];
  try {
    const { data } = await generateJson<{ queries: string[] }>({
      stage: "group",
      system: QUERIES_SYSTEM,
      schema: QUERIES,
      parts: [`QUESTION: ${q}`],
      timeoutMs: 60_000,
    });
    queries = [q, ...(data.queries ?? []).map((s) => s.replace(/["*()]/g, " ").trim()).filter(Boolean)].slice(0, 7);
  } catch {
    // Searched as typed: a worse search beats no search.
  }

  // Each search through the word index, best matches first, all pooled.
  const pool = new Map<number, { id: number; text: string; hits: number; best: number }>();
  const run = db().prepare(
    `SELECT c.id, c.text, bm25(chunks_fts) AS rank
       FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH @match ${opts.sourceId ? "AND c.source_id = @sourceId" : ""}
      ORDER BY rank LIMIT ${PER_QUERY}`
  );
  for (const query of queries) {
    const words = queryWords(query, 6);
    // All the words if they find something, otherwise any of them.
    for (const match of [ftsMatch(words), words.length > 1 ? words.map((w) => ftsMatch([w])).filter(Boolean).join(" OR ") : null]) {
      if (!match) continue;
      let rows: { id: number; text: string; rank: number }[] = [];
      try {
        rows = run.all({ match, sourceId: opts.sourceId }) as typeof rows;
      } catch {
        continue;
      }
      rows.forEach((r, i) => {
        if (isJunkText(r.text)) return;
        const had = pool.get(r.id);
        if (had) {
          had.hits++;
          had.best = Math.min(had.best, i);
        } else pool.set(r.id, { id: r.id, text: r.text, hits: 1, best: i });
      });
      if (rows.length) break;
    }
  }
  if (!pool.size) return [];

  // Found by more searches, and higher up in them, comes first into the reading.
  const candidates = [...pool.values()].sort((a, b) => b.hits - a.hits || a.best - b.best).slice(0, CANDIDATES);

  let order: { id: number; fit: "close" | "related" | "loose" }[];
  try {
    const { data } = await generateJson<{ picks: { n: number; fit: "close" | "related" | "loose" }[] }>({
      stage: "group",
      system: PICK_SYSTEM,
      schema: PICK,
      parts: [
        `QUESTION: ${q}`,
        candidates
          .map((c, i) => `[${i + 1}] ${c.text.replace(/\s+/g, " ").slice(0, SHOWN_CHARS)}`)
          .join("\n\n"),
      ],
      timeoutMs: 120_000,
    });
    const seen = new Set<number>();
    order = (data.picks ?? [])
      .filter((p) => Number.isInteger(p.n) && p.n >= 1 && p.n <= candidates.length && !seen.has(p.n) && seen.add(p.n))
      .map((p) => ({ id: candidates[p.n - 1].id, fit: p.fit }));
  } catch {
    // Unread, the word index's own order is still an answer.
    order = candidates.map((c) => ({ id: c.id, fit: "loose" as const }));
  }
  order = order.slice(0, limit);
  if (!order.length) return [];

  const detail = new Map(
    (
      db()
        .prepare(
          `SELECT c.id, c.text, c.locator_json, c.source_id, s.title, s.author, s.outlet, d.label AS doc_label
             FROM chunks c JOIN sources s ON s.id = c.source_id
             LEFT JOIN documents d ON d.id = c.doc_id
            WHERE c.id IN (${order.map(() => "?").join(",")})`
        )
        .all(...order.map((o) => o.id)) as {
        id: number;
        text: string;
        locator_json: string;
        source_id: number;
        title: string;
        author: string | null;
        outlet: string | null;
        doc_label: string | null;
      }[]
    ).map((r) => [r.id, r])
  );

  return order.flatMap((o, i): Found[] => {
    const d = detail.get(o.id);
    if (!d) return [];
    let locator = "";
    try {
      locator = formatLocator(JSON.parse(d.locator_json) as Locator, d.doc_label);
    } catch {
      locator = d.doc_label ?? "";
    }
    return [
      {
        chunkId: d.id,
        sourceId: d.source_id,
        sourceTitle: d.title,
        author: d.author,
        outlet: d.outlet,
        locator,
        text: d.text,
        score: 1 - i / order.length,
        strength: o.fit,
        via: "reader",
      },
    ];
  });
}
