import { db, tx } from "./db";
import { scriptAlign } from "./align/script";

/**
 * Reading a book beside its translation.
 *
 * Raazi already holds both: a translation is ingested as an ordinary source,
 * with its own chunks, its own citations and its own place on the shelf. This
 * module does the one thing that makes them a pair — works out which passage
 * answers to which — and hands the reader the result.
 *
 * The matching is the one Mutarjim arrived at, and it is deliberately not a
 * model: rare tokens that survive translation untouched (years, figures,
 * names kept in Latin script) pin a monotone skeleton of correspondences, and
 * between those anchors Gale–Church aligns by character length, handling the
 * joins, splits and omissions a real translator produces. It costs nothing,
 * runs in milliseconds over a whole book, and is right about the great
 * majority of it. See lib/align/script.ts for the method itself.
 *
 * What it cannot settle it says so about, on the pair, as a confidence. The
 * reader shows the doubtful ones as doubtful rather than hiding them, because
 * a silent mismatch in a bilingual text is worse than a marked one.
 */

export interface AlignedChunk {
  id: number;
  text: string;
  locator: string | null;
}

export interface AlignedPair {
  id: number;
  seq: number;
  original: AlignedChunk[];
  translation: AlignedChunk[];
  confidence: number;
  via: string;
}

export interface TranslationSummary {
  id: number;
  title: string;
  lang: string | null;
  author: string | null;
  pairs: number;
  /** The share of the original's chunks that found a partner. */
  covered: number;
  alignedAt: string | null;
}

/** Below this a pair is shown, but marked as a guess. */
export const DOUBTFUL = 0.55;

interface Row {
  id: number;
  text: string;
  locator_json: string | null;
}

function chunksOf(sourceId: number): Row[] {
  return db()
    .prepare(
      `SELECT c.id, c.text, c.locator_json
         FROM chunks c
         LEFT JOIN documents d ON d.id = c.doc_id
        WHERE c.source_id = ?
        ORDER BY COALESCE(d.ordinal, 0), c.seq, c.id`
    )
    .all(sourceId) as Row[];
}

/**
 * Marks one source as a translation of another and works out the pairs.
 *
 * Re-running replaces what was there: a book re-ingested, or a translation
 * replaced by a better scan, should not leave half of an old alignment behind.
 */
export function alignTranslation(originalId: number, translationId: number): { pairs: number; covered: number } {
  if (originalId === translationId) throw new Error("A book cannot be its own translation.");

  const original = chunksOf(originalId);
  const translation = chunksOf(translationId);
  if (!original.length) throw new Error("That book has nothing read in yet.");
  if (!translation.length) throw new Error("That translation has nothing read in yet.");

  const result = scriptAlign(
    original.map((c) => c.text),
    translation.map((c) => c.text)
  );

  return tx(() => {
    db()
      .prepare("UPDATE sources SET translation_of=? WHERE id=?")
      .run(originalId, translationId);
    db()
      .prepare("DELETE FROM alignments WHERE original_id=? AND translation_id=?")
      .run(originalId, translationId);

    const insert = db().prepare(
      `INSERT INTO alignments (original_id, translation_id, seq, o_chunks, t_chunks, confidence, via)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    // A passage the matcher could find no partner for is left out of its
    // result entirely — so walking the pairs alone would skip it, and the
    // bilingual page would quietly not contain part of the book. The two
    // index spaces are walked here instead, and anything neither side
    // claimed becomes a row of its own with nothing opposite. Every passage
    // of both texts appears exactly once, in order, which is what makes a
    // gap visible as a gap rather than as everything below it being wrong.
    let seq = 0;
    let matched = 0;
    let nextS = 0;
    let nextT = 0;

    const row = (s: number[], t: number[], confidence: number, via: string) => {
      const o = s.map((i) => original[i]?.id).filter((id): id is number => typeof id === "number");
      const tr = t.map((i) => translation[i]?.id).filter((id): id is number => typeof id === "number");
      if (!o.length && !tr.length) return;
      if (o.length && tr.length) matched += o.length;
      insert.run(originalId, translationId, seq++, JSON.stringify(o), JSON.stringify(tr), confidence, via);
    };
    const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

    for (const pair of result.pairs) {
      const firstS = pair.s.length ? pair.s[0] : nextS;
      const firstT = pair.t.length ? pair.t[0] : nextT;
      if (firstS > nextS) row(range(nextS, firstS), [], 0, "unmatched");
      if (firstT > nextT) row([], range(nextT, firstT), 0, "unmatched");
      row(pair.s, pair.t, pair.confidence, pair.viaAnchor ? "anchor" : "length");
      if (pair.s.length) nextS = pair.s[pair.s.length - 1] + 1;
      if (pair.t.length) nextT = pair.t[pair.t.length - 1] + 1;
    }
    if (nextS < original.length) row(range(nextS, original.length), [], 0, "unmatched");
    if (nextT < translation.length) row([], range(nextT, translation.length), 0, "unmatched");

    return { pairs: seq, covered: original.length ? matched / original.length : 0 };
  });
}

/** The translations attached to a book, with how well each one matched. */
export function translationsOf(originalId: number): TranslationSummary[] {
  const rows = db()
    .prepare(
      `SELECT s.id, s.title, s.lang, s.author,
              (SELECT COUNT(*) FROM alignments a WHERE a.translation_id = s.id) AS pairs,
              (SELECT MAX(a.created_at) FROM alignments a WHERE a.translation_id = s.id) AS alignedAt
         FROM sources s
        WHERE s.translation_of = ?
        ORDER BY s.id`
    )
    .all(originalId) as (TranslationSummary & { pairs: number })[];

  const total = (db().prepare("SELECT COUNT(*) AS n FROM chunks WHERE source_id=?").get(originalId) as { n: number }).n;
  return rows.map((r) => {
    const matched = (
      db()
        .prepare(
          `SELECT COALESCE(SUM(json_array_length(o_chunks)), 0) AS n
             FROM alignments
            WHERE original_id=? AND translation_id=? AND json_array_length(t_chunks) > 0`
        )
        .get(originalId, r.id) as { n: number }
    ).n;
    return { ...r, covered: total ? matched / total : 0 };
  });
}

/** The book a translation belongs to, if it is one. */
export function originalOf(sourceId: number): { id: number; title: string } | null {
  return (
    (db()
      .prepare(
        `SELECT o.id, o.title FROM sources s JOIN sources o ON o.id = s.translation_of WHERE s.id = ?`
      )
      .get(sourceId) as { id: number; title: string } | undefined) ?? null
  );
}

/** Everything the bilingual reader draws, in reading order down the original. */
export function alignedPairs(originalId: number, translationId: number): AlignedPair[] {
  const rows = db()
    .prepare(
      `SELECT id, seq, o_chunks, t_chunks, confidence, via
         FROM alignments WHERE original_id=? AND translation_id=? ORDER BY seq`
    )
    .all(originalId, translationId) as {
    id: number;
    seq: number;
    o_chunks: string;
    t_chunks: string;
    confidence: number;
    via: string;
  }[];
  if (!rows.length) return [];

  // One read of each side, then looked up by id: a book is thousands of
  // chunks and a query per pair is thousands of queries.
  const byId = new Map<number, AlignedChunk>();
  for (const sourceId of [originalId, translationId]) {
    for (const c of chunksOf(sourceId)) {
      byId.set(c.id, { id: c.id, text: c.text, locator: labelOf(c.locator_json) });
    }
  }
  const pick = (json: string): AlignedChunk[] => {
    try {
      return (JSON.parse(json) as number[]).map((id) => byId.get(id)).filter((c): c is AlignedChunk => Boolean(c));
    } catch {
      return [];
    }
  };

  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    original: pick(r.o_chunks),
    translation: pick(r.t_chunks),
    confidence: r.confidence,
    via: r.via,
  }));
}

function labelOf(json: string | null): string | null {
  if (!json) return null;
  try {
    const l = JSON.parse(json) as { chapter?: string; page?: number };
    return l.chapter ?? (l.page !== undefined ? `p. ${l.page}` : null);
  } catch {
    return null;
  }
}

/** Unlinks a translation and forgets the pairs, leaving both sources alone. */
export function unlinkTranslation(translationId: number): void {
  tx(() => {
    db().prepare("DELETE FROM alignments WHERE translation_id=?").run(translationId);
    db().prepare("UPDATE sources SET translation_of=NULL WHERE id=?").run(translationId);
  });
}
