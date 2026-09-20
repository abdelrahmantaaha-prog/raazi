// A bilingual lexicon bootstrapped from the pairs the length model is already
// sure of, used to judge the pairs it is not — the second pass of the classic
// hunalign design.
//
// Length evidence alone cannot tell two same-sized sentences apart, which is
// exactly where alignment goes wrong. But a document that has already yielded
// nine hundred confident pairs has told us what its own vocabulary translates
// to, and that knowledge costs nothing: no model call, no key, no quota.

import { normalize, stemToken } from "./tokens";

const MIN_TOKEN = 3;
/** A token appearing in more than this share of pairs is a function word. */
const STOPWORD_DF = 0.18;
const MIN_COOC = 2;
const MIN_ASSOC = 0.25;

function contentTokens(text: string): string[] {
  const out = new Set<string>();
  for (const raw of normalize(text).split(/[^\p{L}\p{N}’']+/u)) {
    if (raw.length < MIN_TOKEN) continue;
    if (/^\d+$/.test(raw)) continue; // numbers anchor elsewhere
    out.add(stemToken(raw));
  }
  return [...out];
}

export interface Lexicon {
  /** Share of the source's known words whose translation is present in the
   *  target, or null when the pair carries too little evidence to judge. */
  score(sourceText: string, targetText: string): number | null;
  size: number;
}

export function buildLexicon(pairs: { s: string; t: string }[]): Lexicon {
  const srcDf = new Map<string, number>();
  const tgtDf = new Map<string, number>();
  const cooc = new Map<string, Map<string, number>>();

  const rows = pairs.map((p) => ({ s: contentTokens(p.s), t: contentTokens(p.t) }));
  for (const row of rows) {
    for (const a of row.s) srcDf.set(a, (srcDf.get(a) ?? 0) + 1);
    for (const b of row.t) tgtDf.set(b, (tgtDf.get(b) ?? 0) + 1);
  }

  const n = rows.length || 1;
  const isStop = (df: number) => df / n > STOPWORD_DF;
  for (const row of rows) {
    const s = row.s.filter((a) => !isStop(srcDf.get(a) ?? 0));
    const t = row.t.filter((b) => !isStop(tgtDf.get(b) ?? 0));
    // Pairs long enough to be ambiguous teach little per co-occurrence; the
    // association threshold below sorts that out.
    for (const a of s) {
      let row2 = cooc.get(a);
      if (!row2) cooc.set(a, (row2 = new Map()));
      for (const b of t) row2.set(b, (row2.get(b) ?? 0) + 1);
    }
  }

  // Keep each source word's single best partner, by Dice association.
  const best = new Map<string, string>();
  for (const [a, row] of cooc) {
    const dfa = srcDf.get(a) ?? 0;
    let bestB = "";
    let bestScore = 0;
    for (const [b, c] of row) {
      if (c < MIN_COOC) continue;
      const assoc = (2 * c) / (dfa + (tgtDf.get(b) ?? 0));
      if (assoc > bestScore) {
        bestScore = assoc;
        bestB = b;
      }
    }
    if (bestB && bestScore >= MIN_ASSOC) best.set(a, bestB);
  }

  return {
    size: best.size,
    score(sourceText, targetText) {
      const s = contentTokens(sourceText).filter((a) => best.has(a));
      if (s.length < 2) return null; // too little to say anything honest
      const t = new Set(contentTokens(targetText));
      let hit = 0;
      for (const a of s) if (t.has(best.get(a)!)) hit++;
      return hit / s.length;
    },
  };
}
