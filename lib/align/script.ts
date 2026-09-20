// Deterministic sentence alignment: anchor skeleton + Gale–Church DP.
//
// Numbers survive translation untouched (years, figures, footnote markers),
// and so do Latin-kept names inside Arabic text. Rare shared tokens pin a
// monotone skeleton of correspondences — which also locates WHERE a partial
// translation's coverage lies, with zero model calls. Between consecutive
// anchors, classic Gale–Church (1993) aligns by character lengths, handling
// merges (2-1), splits (1-2) and omissions (1-0). Every pair carries a
// confidence; the caller sends only the doubtful ones to a model.

export interface ScriptPair {
  s: number[];
  t: number[];
  confidence: number; // 0..1
  viaAnchor: boolean;
}

export interface ScriptAlignResult {
  pairs: ScriptPair[];
  anchors: number;
  /** Estimated target/source character ratio actually used. */
  lengthRatio: number;
  /** Word pairs learned from this document's own confident alignments. */
  lexicon: number;
}

import { buildLexicon } from "./lexicon";
import { htmlToText as stripTags } from "../richtext";

// Gale–Church bead penalties, in log-probability units (paper values /100).
// 3-1/1-3 are not in the paper; translators who join Arabic sentences with و
// produce them constantly, so they get a penalty between 2-1 and "give up".
const PENALTY = {
  "11": 0,
  "10": 4.5,
  "01": 4.5,
  "21": 2.3,
  "12": 2.3,
  "22": 4.4,
  "31": 3.3,
  "13": 3.3,
};
const VARIANCE = 6.8;
/** DP area cap per inter-anchor segment — beyond this the segment is left to
 *  the model rather than allowed to eat memory. */
const MAX_DP_AREA = 250_000;

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
}

/** Tokens that survive translation: number runs and Latin word runs. */
export function signatureTokens(text: string): string[] {
  const out = new Set<string>();
  const norm = normalizeDigits(text);
  for (const m of norm.matchAll(/\d[\d.,:\/]*/g)) {
    const t = m[0].replace(/[.,:\/]+$/, "").replace(/[.,:\/]/g, "");
    if (t.length >= 2) out.add(`#${t}`);
  }
  for (const m of norm.matchAll(/[A-Za-z][A-Za-z'’-]{3,}/g)) {
    out.add(`L${m[0].toLowerCase()}`);
  }
  return [...out];
}

interface Anchor {
  s: number;
  t: number;
  weight: number;
}

function findAnchors(src: string[], tgt: string[]): Anchor[] {
  const srcTok = new Map<string, number[]>();
  const tgtTok = new Map<string, number[]>();
  const collect = (texts: string[], map: Map<string, number[]>) => {
    texts.forEach((text, i) => {
      for (const tok of signatureTokens(text)) {
        const list = map.get(tok);
        if (list) list.push(i);
        else map.set(tok, [i]);
      }
    });
  };
  collect(src, srcTok);
  collect(tgt, tgtTok);

  // A token is anchor-grade only when RARE on both sides — "2023" twelve
  // times pins nothing, and common English words never qualify because the
  // English side sees them everywhere.
  const points: Anchor[] = [];
  for (const [tok, sIdxs] of srcTok) {
    const tIdxs = tgtTok.get(tok);
    if (!tIdxs || sIdxs.length > 3 || tIdxs.length > 3) continue;
    const weight = 1 / (sIdxs.length * tIdxs.length);
    for (const s of sIdxs) for (const t of tIdxs) points.push({ s, t, weight });
  }
  points.sort((a, b) => a.s - b.s || a.t - b.t);

  // Maximum-weight strictly-monotone chain (O(k²) — k stays small because
  // only rare tokens produce points).
  const best = new Array<number>(points.length).fill(0);
  const prev = new Array<number>(points.length).fill(-1);
  let endIdx = -1;
  let endScore = 0;
  for (let i = 0; i < points.length; i++) {
    best[i] = points[i].weight;
    for (let j = 0; j < i; j++) {
      if (points[j].s < points[i].s && points[j].t < points[i].t && best[j] + points[i].weight > best[i]) {
        best[i] = best[j] + points[i].weight;
        prev[i] = j;
      }
    }
    if (best[i] > endScore) {
      endScore = best[i];
      endIdx = i;
    }
  }
  const chain: Anchor[] = [];
  for (let i = endIdx; i >= 0; i = prev[i]) chain.push(points[i]);
  chain.reverse();

  // One anchor per sentence on each side; chain construction guarantees
  // monotonicity, this pass just collapses duplicates.
  const seen = new Set<string>();
  return chain.filter((a) => {
    const key = `${a.s}:${a.t}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** δ per Gale–Church: how surprising this length pairing is under ratio c. */
function delta(l1: number, l2: number, c: number): number {
  if (l1 === 0 && l2 === 0) return 0;
  const mean = (l1 + l2 / c) / 2;
  return (l2 - l1 * c) / Math.sqrt(Math.max(mean, 1) * VARIANCE);
}

interface Bead {
  s: number[];
  t: number[];
  cost: number;
  d: number;
}

/** Full DP over one bounded region. Returns beads with LOCAL indices. */
function galeChurch(srcLens: number[], tgtLens: number[], c: number): Bead[] | null {
  const n = srcLens.length;
  const m = tgtLens.length;
  if ((n + 1) * (m + 1) > MAX_DP_AREA) return null;
  const INF = Number.POSITIVE_INFINITY;
  const cost = new Float64Array((n + 1) * (m + 1)).fill(INF);
  const back = new Int8Array((n + 1) * (m + 1)); // move id
  const at = (i: number, j: number) => i * (m + 1) + j;
  cost[0] = 0;

  const MOVES: [number, number, keyof typeof PENALTY][] = [
    [1, 1, "11"],
    [1, 0, "10"],
    [0, 1, "01"],
    [2, 1, "21"],
    [1, 2, "12"],
    [2, 2, "22"],
    [3, 1, "31"],
    [1, 3, "13"],
  ];

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const base = cost[at(i, j)];
      if (base === INF) continue;
      for (let k = 0; k < MOVES.length; k++) {
        const [di, dj, key] = MOVES[k];
        const ni = i + di;
        const nj = j + dj;
        if (ni > n || nj > m) continue;
        let step = PENALTY[key];
        if (di > 0 && dj > 0) {
          let l1 = 0;
          for (let a = 0; a < di; a++) l1 += srcLens[i + a] || 0;
          let l2 = 0;
          for (let b = 0; b < dj; b++) l2 += tgtLens[j + b] || 0;
          const d = delta(l1, l2, c);
          step += (d * d) / 2;
        }
        if (base + step < cost[at(ni, nj)]) {
          cost[at(ni, nj)] = base + step;
          back[at(ni, nj)] = k + 1;
        }
      }
    }
  }
  if (cost[at(n, m)] === INF) return null;

  const beads: Bead[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const move = back[at(i, j)];
    if (move === 0) return null; // unreachable cell — malformed input
    const [di, dj] = MOVES[move - 1];
    // push, not unshift: this loop runs k = di..1, so unshift would build the
    // indices DESCENDING — every merged bead's sentences joined in reverse.
    const s: number[] = [];
    const t: number[] = [];
    for (let k = di; k > 0; k--) s.push(i - k);
    for (let k = dj; k > 0; k--) t.push(j - k);
    const l1 = s.reduce((sum, x) => sum + srcLens[x], 0);
    const l2 = t.reduce((sum, x) => sum + tgtLens[x], 0);
    beads.unshift({ s, t, cost: 0, d: s.length && t.length ? delta(l1, l2, c) : 0 });
    i -= di;
    j -= dj;
  }
  return beads;
}

export function scriptAlign(src: string[], tgt: string[]): ScriptAlignResult {
  // Length evidence must measure TEXT — inline formatting tags would inflate
  // a heavily-styled sentence into a false mismatch.
  const srcLens = src.map((s) => stripTags(s).length);
  const tgtLens = tgt.map((s) => stripTags(s).length);
  const anchors = findAnchors(src, tgt);

  // The length ratio comes from the anchored region — a global ratio lies
  // whenever the translation is incomplete.
  let c = 0.95;
  if (anchors.length >= 2) {
    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    const sSum = srcLens.slice(first.s, last.s + 1).reduce((a, b) => a + b, 0);
    const tSum = tgtLens.slice(first.t, last.t + 1).reduce((a, b) => a + b, 0);
    if (sSum > 200 && tSum > 200) c = tSum / sSum;
  } else if (tgt.length / Math.max(src.length, 1) > 0.6 && tgt.length / Math.max(src.length, 1) < 1.7) {
    const sSum = srcLens.reduce((a, b) => a + b, 0);
    const tSum = tgtLens.reduce((a, b) => a + b, 0);
    if (sSum > 0) c = tSum / sSum;
  }
  c = Math.min(2.5, Math.max(0.4, c));

  // Anchors that are wildly length-implausible are token coincidences.
  const goodAnchors = anchors.filter(
    (a) => Math.abs(delta(srcLens[a.s], tgtLens[a.t], c)) <= 3.5,
  );

  const pairs: ScriptPair[] = [];
  for (const a of goodAnchors) {
    pairs.push({ s: [a.s], t: [a.t], confidence: 0.97, viaAnchor: true });
  }

  // DP regions between consecutive anchors, plus a BOUNDED margin before the
  // first and after the last — the far side of an incomplete translation
  // must never open an enormous DP against an already-exhausted target.
  const bounds: { s0: number; s1: number; t0: number; t1: number }[] = [];
  const anchorList = goodAnchors;
  // Generous: the head and tail are where the two files diverge most (front
  // matter, indexes), and the DP area cap already bounds the cost.
  const margin = (tgtSpan: number) => tgtSpan * 4 + 40;
  if (anchorList.length === 0) {
    if (tgt.length && src.length) bounds.push({ s0: 0, s1: src.length, t0: 0, t1: tgt.length });
  } else {
    const first = anchorList[0];
    bounds.push({
      s0: Math.max(0, first.s - margin(first.t)),
      s1: first.s,
      t0: 0,
      t1: first.t,
    });
    for (let i = 0; i < anchorList.length - 1; i++) {
      bounds.push({
        s0: anchorList[i].s + 1,
        s1: anchorList[i + 1].s,
        t0: anchorList[i].t + 1,
        t1: anchorList[i + 1].t,
      });
    }
    const last = anchorList[anchorList.length - 1];
    const tgtLeft = tgt.length - last.t - 1;
    bounds.push({
      s0: last.s + 1,
      s1: Math.min(src.length, last.s + 1 + margin(tgtLeft)),
      t0: last.t + 1,
      t1: tgt.length,
    });
  }

  for (const b of bounds) {
    const sSpan = b.s1 - b.s0;
    const tSpan = b.t1 - b.t0;
    if (sSpan <= 0 || tSpan <= 0) continue;
    const beads = galeChurch(
      srcLens.slice(b.s0, b.s1),
      tgtLens.slice(b.t0, b.t1),
      c,
    );
    if (!beads) continue; // region too large or degenerate — model's problem
    // A region thick with deletions (untranslated front matter, a skipped
    // stretch) is weaker evidence — but only mildly. Demoting hard punished
    // every pair in the front matter, where a dense run of real translation
    // sits among a hundred untranslated endorsements and TOC lines: a bead
    // whose lengths fit perfectly is still a match, whatever surrounds it.
    const matched = beads.filter((x) => x.s.length && x.t.length).length;
    const health = beads.length ? matched / beads.length : 0;
    const regionFactor = 0.75 + 0.25 * health;
    for (const bead of beads) {
      if (!bead.s.length || !bead.t.length) continue;
      const merge = bead.s.length > 1 || bead.t.length > 1;
      const confidence =
        Math.max(0, 1 - Math.abs(bead.d) / 3) * (merge ? 0.85 : 1) * regionFactor;
      pairs.push({
        s: bead.s.map((i) => i + b.s0),
        t: bead.t.map((j) => j + b.t0),
        confidence,
        viaAnchor: false,
      });
    }
  }

  pairs.sort((a, b) => a.s[0] - b.s[0]);

  // Second pass: the document teaches us its own vocabulary. Pairs the length
  // model was sure of become a bilingual lexicon, and that lexicon judges the
  // pairs it was not sure of — real evidence about MEANING, for free, where
  // before only a model call could help.
  const CONF = 0.72;
  const textOf = (idx: number[], texts: string[]) => idx.map((i) => texts[i]).join(" ");
  const teaching = pairs
    .filter((p) => p.confidence >= CONF)
    .map((p) => ({ s: textOf(p.s, src), t: textOf(p.t, tgt) }));
  let lexiconSize = 0;
  if (teaching.length >= 40) {
    const lex = buildLexicon(teaching);
    lexiconSize = lex.size;
    if (lex.size >= 30) {
      for (const p of pairs) {
        if (p.confidence >= CONF || p.viaAnchor) continue;
        const score = lex.score(textOf(p.s, src), textOf(p.t, tgt));
        if (score == null) continue;
        // Most of the known words landing is strong evidence on its own; a
        // near-total miss is evidence against, and drops the pair below the
        // band worth spending a model call on.
        if (score >= 0.5) p.confidence = Math.max(p.confidence, 0.85);
        else if (score >= 0.34) p.confidence = Math.max(p.confidence, 0.62);
        else if (score === 0) p.confidence = Math.min(p.confidence, 0.3);
      }
    }
  }

  // Sandwich promotion: a middling pair whose immediate neighbors BOTH hold
  // confident, tightly-adjacent alignments is boxed in — it can only be the
  // sentences between them. Promote it without spending a model call. Two
  // passes so a freshly promoted pair can vouch for the one beside it.
  const CONFIDENT = 0.72;
  const PROMOTED = 0.8;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < pairs.length - 1; i++) {
      const p = pairs[i];
      if (p.confidence >= CONFIDENT || p.confidence < 0.3) continue;
      const prev = pairs[i - 1];
      const next = pairs[i + 1];
      const gap = (a: number, b: number) => b - a;
      const boxed =
        prev.confidence >= CONFIDENT &&
        next.confidence >= CONFIDENT &&
        gap(prev.s[prev.s.length - 1], p.s[0]) >= 1 &&
        gap(prev.s[prev.s.length - 1], p.s[0]) <= 2 &&
        gap(p.s[p.s.length - 1], next.s[0]) >= 1 &&
        gap(p.s[p.s.length - 1], next.s[0]) <= 2 &&
        gap(prev.t[prev.t.length - 1], p.t[0]) >= 1 &&
        gap(prev.t[prev.t.length - 1], p.t[0]) <= 2 &&
        gap(p.t[p.t.length - 1], next.t[0]) >= 1 &&
        gap(p.t[p.t.length - 1], next.t[0]) <= 2;
      if (boxed) p.confidence = Math.max(p.confidence, PROMOTED);
    }
  }

  return { pairs, anchors: anchorList.length, lengthRatio: c, lexicon: lexiconSize };
}
