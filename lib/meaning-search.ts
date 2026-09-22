import crypto from "node:crypto";
import { db, tx } from "./db";
import { embed } from "./ai/client";
import { getConfig } from "./config";
import { cosine, fromBlob, toBlob } from "./normalize";
import { formatLocator } from "./chunk";
import { isJunkText } from "./junk-text";
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
 * How it ranks was settled by measurement, on 22 September 2026, against 36
 * hand-written questions whose right passage was known — 24 vague ones that
 * paraphrase a passage while avoiding its words, 12 that name a person, a
 * company or a decree. What it found, and so what this does:
 *
 * - **Meaning orders the list.** The first version blended in a full-text
 *   ranking with fixed weights, and it made both kinds of question worse:
 *   right passage first 13 of 24 times for the vague ones against 18 by
 *   meaning alone, and "Al Smooth" — a nickname, exactly what words are for —
 *   sank to 1,956th. Two faults compounded. The word query was every word of
 *   the question joined by AND, so a vague question matched nothing, or
 *   matched the wrong long passage; and the weights meant a passage matching
 *   both scored 0.75·m + 0.25·w against 0.85·m for one matching meaning
 *   alone, so being found by your words could push a passage *down*.
 *
 * - **Only rare words lift.** A word bonus helps names and hurts vague
 *   questions in equal measure, because a vague question's words ("children",
 *   "government") are everywhere. Counting only the words that appear in at
 *   most one passage in two hundred leaves vague questions ranked by meaning
 *   exactly as before and moved name searches from 7 of 12 first to 10 of 12.
 *
 * - **The library stays as it was embedded.** Re-embedding every passage as a
 *   "retrieval document", which is what the provider recommends for search,
 *   was measured too and was markedly worse here (right passage first 12 of 24
 *   against 18). Nothing is re-indexed.
 *
 * - **Strength, not a percentage.** Similarity from this model is compressed:
 *   the least related passage in the library scores about 0.60 against any
 *   question and the median about 0.70, so "71%" said nothing — it is what a
 *   passage picked at random gets. What does separate is distance from the
 *   library's own average, in standard deviations: the right passage sat a
 *   median 4.95 above it and never below 3.1, while the 20th result sits
 *   around 2.9. That becomes a band. It is not a verdict — among thousands of
 *   passages the best of pure chance lands near 3.5 — which is why the lowest
 *   band is called loosely related and not relevant.
 */

export interface Found {
  chunkId: number;
  sourceId: number;
  sourceTitle: string;
  author: string | null;
  outlet: string | null;
  locator: string;
  text: string;
  /** The ranking value. Only an order — never a claim about correctness. */
  score: number;
  /**
   * How far this passage stands above the rest of the library for this
   * question. Null when the library is too small for that to mean anything.
   */
  strength: "close" | "related" | "loose" | null;
  /** Found by meaning alone, or lifted by a rare word of yours it contains. */
  via: "meaning" | "words" | "both";
}

export interface Coverage {
  /** Passages that can be searched this way — text, not bytes. */
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

/** A word in at most this share of the library counts as rare. */
const RARE_SHARE = 0.005;
/** What a passage gains for holding every rare word of the question. */
const RARE_LIFT = 0.03;
/** Below this many passages, distance from the average means nothing. */
const MIN_FOR_STRENGTH = 200;
/** Standard deviations above the library's average for this question. */
const CLOSE = 4.5;
const RELATED = 3.8;

/** Words that say nothing about what a passage is about. */
const STOP = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "just more most much no not of on or our so some than that the their them then there these they this those " +
    "to up was we were what when where which who whom why will with would you your about after before over " +
    "only same such very across also while during between both each few other any all own too " +
    "في من على إلى عن مع هذا هذه ذلك التي الذي كيف ما ماذا لماذا هل أن إن كان قد لم لن ثم أو و"
  ).split(" ")
);

/**
 * A row with no vector, standing for a passage that is not text: it keeps
 * the passage from being offered to the indexer on every pass, and is left
 * out of the counts and the ranking. Dim 0 is the mark.
 */
const TOMBSTONE = Buffer.alloc(0);

function hashOf(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** The words of a question worth looking up in the index. */
export function contentWords(q: string): string[] {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP.has(w) && (w.length > 2 || /\d/.test(w)));
  return [...new Set(words)].slice(0, 12);
}

/** What has a current vector, and what does not. Passages that are not text are not counted. */
export function coverage(sourceId?: number): Coverage {
  const where = sourceId ? "WHERE c.source_id = ?" : "";
  const model = getConfig().embedModel;
  const row = db()
    .prepare(
      `SELECT SUM(CASE WHEN v.dim = 0 THEN 0 ELSE 1 END) AS chunks,
              SUM(CASE WHEN v.dim > 0 AND v.model = ? THEN 1 ELSE 0 END) AS embedded,
              SUM(CASE WHEN v.dim > 0 AND v.model != ? THEN 1 ELSE 0 END) AS stale
         FROM chunks c LEFT JOIN chunk_vectors v ON v.chunk_id = c.id ${where}`
    )
    .get(model, model, ...(sourceId ? [sourceId] : [])) as {
    chunks: number | null;
    embedded: number | null;
    stale: number | null;
  };
  return { chunks: row.chunks ?? 0, embedded: row.embedded ?? 0, stale: row.stale ?? 0 };
}

/**
 * Gives passages that have no current vector one, a batch at a time.
 *
 * Returns how many it did, so a caller can keep going until it returns zero.
 * Bounded by `limit` because this is the only part of the feature that spends
 * anything, and an unbounded pass over a library of six thousand passages is
 * not something a page request should start.
 *
 * A passage that is not text is marked rather than embedded, and marked
 * rather than skipped: skipped, it would be offered again on every pass and
 * could fill a whole batch with nothing to do while real passages waited.
 */
export async function embedPassages(
  opts: { limit?: number; sourceId?: number; embedder?: Embedder } = {}
): Promise<number> {
  const embedWith = opts.embedder ?? embed;
  const limit = Math.max(1, Math.min(opts.limit ?? BATCH * 4, 2_000));
  const model = getConfig().embedModel;

  const rows = db()
    .prepare(
      `SELECT c.id, c.source_id, c.text, v.hash, v.model
         FROM chunks c LEFT JOIN chunk_vectors v ON v.chunk_id = c.id
        WHERE (v.chunk_id IS NULL OR (v.dim > 0 AND v.model != ?))
          ${opts.sourceId ? "AND c.source_id = ?" : ""}
        ORDER BY c.id
        LIMIT ?`
    )
    .all(model, ...(opts.sourceId ? [opts.sourceId] : []), limit) as {
    id: number;
    source_id: number;
    text: string;
    hash: string | null;
    model: string | null;
  }[];
  if (!rows.length) return 0;

  const mark = db().prepare(
    `INSERT INTO chunk_vectors (chunk_id, source_id, vec, model, dim, hash)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(chunk_id) DO UPDATE SET vec=excluded.vec, model=excluded.model, dim=0, hash=excluded.hash`
  );
  const unreadable = rows.filter((r) => r.text.trim().length <= 40 || isJunkText(r.text));
  if (unreadable.length) {
    tx(() => {
      for (const r of unreadable) mark.run(r.id, r.source_id, TOMBSTONE, model, hashOf(r.text));
    });
  }
  const todo = rows.filter((r) => !unreadable.includes(r));
  let done = unreadable.length;

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

/** Which of a set of passages hold a word, from the full-text index. */
function holders(word: string): Set<number> {
  try {
    return new Set(
      (
        db()
          .prepare(`SELECT rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 5000`)
          .all(`"${word}"`) as { id: number }[]
      ).map((r) => r.id)
    );
  } catch {
    return new Set();
  }
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
      `SELECT v.chunk_id, v.vec, v.dim
         FROM chunk_vectors v
        WHERE v.model = ? AND v.dim = ? ${opts.sourceId ? "AND v.source_id = ?" : ""}
        LIMIT ?`
    )
    .all(model, qv.length, ...(opts.sourceId ? [opts.sourceId] : []), MAX_VECTORS) as {
    chunk_id: number;
    vec: Buffer;
    dim: number;
  }[];
  if (!rows.length) return { results: [], coverage: cov };

  const sims = new Map<number, number>();
  for (const r of rows) {
    const v = fromBlob(r.vec);
    if (v) sims.set(r.chunk_id, cosine(qv, v));
  }
  const n = sims.size;
  let mean = 0;
  for (const s of sims.values()) mean += s;
  mean /= n || 1;
  let variance = 0;
  for (const s of sims.values()) variance += (s - mean) ** 2;
  const sd = Math.sqrt(variance / (n || 1)) || 1;

  // The rare words of the question, and which passages hold them. A word
  // most of the library contains says nothing about which passage you mean.
  const rare = contentWords(q)
    .map(holders)
    .map((set) => new Set([...set].filter((id) => sims.has(id))))
    .filter((set) => set.size > 0 && set.size <= Math.max(3, n * RARE_SHARE));

  const scored = [...sims].map(([id, cos]) => {
    const share = rare.length ? rare.filter((set) => set.has(id)).length / rare.length : 0;
    return { id, cos, z: (cos - mean) / sd, rank: cos + RARE_LIFT * share, lifted: share > 0 };
  });
  scored.sort((a, b) => b.rank - a.rank);
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

  const judged = n >= MIN_FOR_STRENGTH;
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
      score: Math.min(1, t.rank),
      strength: judged ? (t.z >= CLOSE ? "close" : t.z >= RELATED ? "related" : "loose") : null,
      via: t.lifted ? (judged && t.z < RELATED ? "words" : "both") : "meaning",
    });
  }
  return { results, coverage: cov };
}
