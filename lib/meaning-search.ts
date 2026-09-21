import crypto from "node:crypto";
import { db, tx } from "./db";
import { embed } from "./ai/client";
import { getConfig } from "./config";
import { cosine, fromBlob, toBlob } from "./normalize";
import { ftsMatch, queryWords } from "./fts";
import { formatLocator } from "./chunk";
import type { Locator } from "./types";

/**
 * Asking the library a vague question and getting passages back.
 *
 * The search already here matches words, which is the right tool when you know
 * the word: "Shaheen" finds Shaheen. It is the wrong tool for the question you
 * actually have at four in the afternoon — "what did people say about the cost
 * of the war before the CBO number came out" — where you do not know which
 * words the passage uses and the passage may use none of yours.
 *
 * So the question is embedded and compared against a vector for every passage.
 * What comes back is **passages**, ranked: the text, its source, and where in
 * it. Deliberately not an answer. A generated answer is a claim with no
 * address, and the whole of this application is built on the opposite — you
 * read the passage and decide what it says. The model here never sees the
 * library's text at query time and never writes a sentence; it turns your
 * question into a vector, and the comparing is arithmetic.
 *
 * Word matching is not discarded, because it is better than meaning at exactly
 * the thing meaning is bad at: a name, a figure, a statute. The two rankings
 * are blended, so a passage that is both about your question and contains your
 * words outranks one that is only either.
 */

export interface Found {
  chunkId: number;
  sourceId: number;
  sourceTitle: string;
  author: string | null;
  outlet: string | null;
  locator: string;
  text: string;
  /** 0..1, and only ever a ranking — never a claim about correctness. */
  score: number;
  /** Why it is here: both rankings, one, or the other. */
  via: "meaning" | "words" | "both";
}

export interface Coverage {
  chunks: number;
  embedded: number;
  stale: number;
}

/**
 * How the question and the passages become vectors.
 *
 * Injectable so the ranking can be tested without a network or a key — the
 * tests pass a tiny bag-of-words embedder and check that the passage about
 * the cost of the war outranks the recipe for bread. Production passes
 * nothing and gets Gemini.
 */
export type Embedder = (texts: string[]) => Promise<{ vectors: Float32Array[] }>;

/**
 * How many passages one embedding call carries, and how much of each.
 *
 * Small, and smaller than it looks like it could be. The free tier meters
 * embeddings by tokens per minute, not only by requests, and sixty-four
 * passages of four thousand characters is roughly twenty-four thousand tokens
 * in a single call — which refuses instantly, and because the refusal is a
 * plain rate limit with no window on it, the ring rested all thirty-two keys
 * for half an hour and stalled the rest of the pipeline with them. Sixteen
 * passages of sixteen hundred characters is about a tenth of that, and a
 * passage here is around fifteen hundred characters anyway, so almost nothing
 * is being cut.
 */
const BATCH = 16;
const MAX_CHARS = 1_600;
/** A breath between calls, for the same reason. */
const BETWEEN_MS = 250;
/** The most the ranking ever loads into memory at once. */
const MAX_VECTORS = 40_000;
/** Below this a passage is not about the question at all. */
const FLOOR = 0.34;

function hashOf(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** What has a current vector, and what does not. */
export function coverage(sourceId?: number): Coverage {
  const where = sourceId ? "WHERE c.source_id = ?" : "";
  const args = sourceId ? [sourceId] : [];
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS chunks,
              SUM(CASE WHEN v.chunk_id IS NOT NULL THEN 1 ELSE 0 END) AS embedded,
              SUM(CASE WHEN v.chunk_id IS NOT NULL AND v.model != ? THEN 1 ELSE 0 END) AS stale
         FROM chunks c LEFT JOIN chunk_vectors v ON v.chunk_id = c.id ${where}`
    )
    .get(getConfig().embedModel, ...args) as { chunks: number; embedded: number | null; stale: number | null };
  return { chunks: row.chunks, embedded: row.embedded ?? 0, stale: row.stale ?? 0 };
}

/**
 * Gives passages that have no current vector one, a batch at a time.
 *
 * Returns how many it did, so a caller can keep going until it returns zero.
 * Bounded by `limit` because this is the only part of the feature that spends
 * anything, and an unbounded pass over a library of six thousand passages is
 * not something a page request should start.
 */
export async function embedPassages(
  opts: { limit?: number; sourceId?: number; embedder?: Embedder } = {}
): Promise<number> {
  const embedWith = opts.embedder ?? embed;
  const limit = Math.max(1, Math.min(opts.limit ?? BATCH * 4, 2_000));
  const model = getConfig().embedModel;

  const rows = db()
    .prepare(
      `SELECT c.id, c.source_id, c.text
         FROM chunks c LEFT JOIN chunk_vectors v ON v.chunk_id = c.id
        WHERE length(trim(c.text)) > 40
          ${opts.sourceId ? "AND c.source_id = ?" : ""}
          -- Missing, or made by a different model. Text that changed cannot be
          -- caught here (SQL has no sha1), but re-reading a source deletes and
          -- recreates its chunks, so changed text arrives as a new id with no
          -- vector at all. The hash below is the belt to that pair of braces.
          AND (v.chunk_id IS NULL OR v.model != ?)
        ORDER BY c.id
        LIMIT ?`
    )
    .all(...(opts.sourceId ? [opts.sourceId] : []), model, limit) as {
    id: number;
    source_id: number;
    text: string;
  }[];

  // The hash check above cannot be done in SQL against the live text, so the
  // rows that already have a vector are filtered here.
  const existing = new Map(
    (
      db()
        .prepare(
          `SELECT chunk_id, hash, model FROM chunk_vectors WHERE chunk_id IN (${rows.map(() => "?").join(",") || "NULL"})`
        )
        .all(...rows.map((r) => r.id)) as { chunk_id: number; hash: string; model: string }[]
    ).map((r) => [r.chunk_id, r])
  );
  const todo = rows.filter((r) => {
    const had = existing.get(r.id);
    return !had || had.model !== model || had.hash !== hashOf(r.text);
  });
  if (!todo.length) return 0;

  let done = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    if (i > 0) await new Promise((r) => setTimeout(r, BETWEEN_MS));
    let vectors: Float32Array[];
    try {
      ({ vectors } = await embedWith(slice.map((r) => r.text.slice(0, MAX_CHARS))));
    } catch (err) {
      // The service said no partway through. What is already written stays
      // written and the count comes back, so the caller can stop rather than
      // lose the batches that did land — indexing a library is a long errand
      // and having to start it again from nothing is the worst outcome.
      if (done > 0) return done;
      throw err;
    }
    tx(() => {
      const stmt = db().prepare(
        `INSERT INTO chunk_vectors (chunk_id, source_id, vec, model, dim, hash)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id) DO UPDATE SET
           vec=excluded.vec, model=excluded.model, dim=excluded.dim,
           hash=excluded.hash, created_at=datetime('now')`
      );
      slice.forEach((r, k) => {
        const v = vectors[k];
        if (!v?.length) return;
        stmt.run(r.id, r.source_id, toBlob(v), model, v.length, hashOf(r.text));
        done++;
      });
    });
  }
  return done;
}

/**
 * The search itself.
 *
 * Nothing is generated and nothing is summarised: the question becomes one
 * vector, and everything after that is arithmetic over vectors already stored.
 */
export async function askLibrary(
  question: string,
  opts: { limit?: number; sourceId?: number; embedder?: Embedder } = {}
): Promise<{ results: Found[]; coverage: Coverage }> {
  const embedWith = opts.embedder ?? embed;
  const q = question.trim();
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 60));
  const cov = coverage(opts.sourceId);
  if (!q) return { results: [], coverage: cov };

  const model = getConfig().embedModel;
  const { vectors } = await embedWith([q]);
  const qv = vectors[0];
  if (!qv?.length) throw new Error("The question could not be read.");

  const rows = db()
    .prepare(
      `SELECT v.chunk_id, v.source_id, v.vec, v.dim
         FROM chunk_vectors v
        WHERE v.model = ? ${opts.sourceId ? "AND v.source_id = ?" : ""}
        LIMIT ?`
    )
    .all(model, ...(opts.sourceId ? [opts.sourceId] : []), MAX_VECTORS) as {
    chunk_id: number;
    source_id: number;
    vec: Buffer;
    dim: number;
  }[];

  const byMeaning = new Map<number, number>();
  for (const r of rows) {
    if (r.dim !== qv.length) continue;
    const v = fromBlob(r.vec);
    if (!v) continue;
    const s = cosine(qv, v);
    if (s >= FLOOR) byMeaning.set(r.chunk_id, s);
  }

  // The word ranking over the same question, so a name or a figure in it still
  // counts for something. Best-effort: a query the index cannot parse simply
  // leaves the meaning ranking standing on its own.
  const byWord = new Map<number, number>();
  const match = ftsMatch(queryWords(q));
  if (match) {
    try {
      const hits = db()
        .prepare(
          `SELECT c.id AS chunk_id, bm25(chunks_fts) AS rank
             FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
            WHERE chunks_fts MATCH ? ${opts.sourceId ? "AND c.source_id = ?" : ""}
            ORDER BY rank LIMIT 200`
        )
        .all(match, ...(opts.sourceId ? [opts.sourceId] : [])) as { chunk_id: number; rank: number }[];
      // bm25 is negative and unbounded; position in the list is enough, and
      // is the one thing that compares across queries.
      hits.forEach((h, i) => byWord.set(h.chunk_id, 1 - i / Math.max(hits.length, 1)));
    } catch {
      /* an index that would not take the query; meaning alone, then */
    }
  }

  const ids = new Set([...byMeaning.keys(), ...byWord.keys()]);
  if (!ids.size) return { results: [], coverage: cov };

  const scored = [...ids].map((id) => {
    const m = byMeaning.get(id) ?? 0;
    const w = byWord.get(id) ?? 0;
    // Meaning leads, because that is the question being asked; words are a
    // lift rather than a ranking of their own, or a passage that merely
    // repeats a common word would outrank one that answers.
    const score = m > 0 && w > 0 ? m * 0.75 + w * 0.25 : m > 0 ? m * 0.85 : w * 0.45;
    return { id, score, via: (m > 0 && w > 0 ? "both" : m > 0 ? "meaning" : "words") as Found["via"] };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  const detail = new Map(
    (
      db()
        .prepare(
          `SELECT c.id, c.text, c.locator_json, c.source_id,
                  s.title, s.author, s.outlet, d.label AS doc_label
             FROM chunks c
             JOIN sources s ON s.id = c.source_id
             LEFT JOIN documents d ON d.id = c.doc_id
            WHERE c.id IN (${top.map(() => "?").join(",") || "NULL"})`
        )
        .all(...top.map((t) => t.id)) as {
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

  const results: Found[] = [];
  for (const t of top) {
    const d = detail.get(t.id);
    if (!d) continue;
    let locator = "";
    try {
      locator = formatLocator(JSON.parse(d.locator_json) as Locator, d.doc_label);
    } catch {
      locator = d.doc_label ?? "";
    }
    results.push({
      chunkId: d.id,
      sourceId: d.source_id,
      sourceTitle: d.title,
      author: d.author,
      outlet: d.outlet,
      locator,
      text: d.text,
      score: Math.min(1, t.score),
      via: t.via,
    });
  }
  return { results, coverage: cov };
}
