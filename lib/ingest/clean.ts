import type { Piece } from "../chunk";
import { estimateTokens } from "../chunk";

/**
 * Everything here is local, free, and happens before a single token is spent.
 *
 * Born-digital PDFs and web articles already reach Gemini as extracted text
 * rather than as files — so the way to make them cheaper is not to convert them
 * again, it is to stop sending the parts that are not prose.
 *
 * Measured on a real 766,000-character academic PDF in this library: 35.6% of
 * its text was endnotes and bibliography. Those pages cost the same per token as
 * the argument does and tell you almost nothing, because a reference list is a
 * list of works, not a passage about them.
 */

export interface CleanResult {
  pieces: Piece[];
  dropped: {
    apparatusPieces: number;
    apparatusChars: number;
    furnitureLines: number;
    charsBefore: number;
    charsAfter: number;
    tokensSaved: number;
  };
}

export interface CleanOptions {
  /** Drop endnotes, bibliographies and reference lists. */
  stripApparatus?: boolean;
  /** Drop running headers, footers and bare page numbers. */
  stripFurniture?: boolean;
}

const HEADINGS =
  /^\s*(?:\d+\.?\s*)?(references|bibliography|works cited|notes|endnotes|footnotes|further reading|sources|index)\s*:?\s*$/i;

/** Arabic research writing labels the same sections differently. */
const HEADINGS_AR = /^\s*(المراجع|المصادر|الهوامش|قائمة المراجع|ثبت المراجع|الفهرس)\s*:?\s*$/;

const CITATION_PATTERNS: RegExp[] = [
  /https?:\/\/\S+/,                                  // a bare URL
  /\bdoi:\s*10\.\d{4}/i,                             // a DOI
  /\b(?:Retrieved|Accessed|Available at)\b/i,        // retrieval notes
  /\b(?:ibid|op\.\s?cit|loc\.\s?cit|et al)\b\.?/i,   // scholarly shorthand
  /^\s*\d{1,4}[\s.]+[A-Z؀-ۿ][\w'’؀-ۿ-]+,\s/, // "12 Vaughan, Don."
  /[A-Z][a-z]+,\s+[A-Z][a-z.]*\.?\s*(?:\(|\b)(?:19|20)\d\d\b/,   // "Vaughan, D. (2023"
  /\((?:19|20)\d\d\)\s*[.,]/,                        // "(2023)."
  /\bpp?\.\s*\d+(?:[–-]\d+)?/,                       // "pp. 21–34"
  /\bvol\.\s*\d+/i,
];

function citationScore(line: string): boolean {
  const t = line.trim();
  if (t.length < 12) return false;
  return CITATION_PATTERNS.some((re) => re.test(t));
}

/**
 * How much of this block reads as bibliography. Judged per block rather than
 * per document because endnotes often sit at the end of every chapter, not only
 * at the end of the book.
 */
function apparatusRatio(text: string): number {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 4) return 0;
  return lines.filter(citationScore).length / lines.length;
}

/** Enough citation-shaped lines that this is a list of works, not an argument. */
const APPARATUS_RATIO = 0.4;

export function clean(pieces: Piece[], opts: CleanOptions = {}): CleanResult {
  const stripApparatus = opts.stripApparatus !== false;
  const stripFurniture = opts.stripFurniture !== false;

  const charsBefore = pieces.reduce((n, p) => n + p.text.length, 0);
  let furnitureLines = 0;
  let apparatusPieces = 0;
  let apparatusChars = 0;

  let work = pieces;

  // --- page furniture -------------------------------------------------------
  if (stripFurniture) {
    const furniture = repeatedLines(work);
    work = work.map((p) => {
      const lines = p.text.split("\n");
      const kept = lines.filter((l) => {
        const t = l.trim();
        if (furniture.has(t) || isPageNumber(t)) {
          furnitureLines++;
          return false;
        }
        return true;
      });
      return { ...p, text: kept.join("\n") };
    });
  }

  // --- endnotes and bibliography -------------------------------------------
  if (stripApparatus) {
    // An explicit heading means everything after it is apparatus, provided the
    // rest of the document agrees — a chapter called "Notes" mid-book should
    // not silently delete the second half of a book that has no bibliography.
    let cutFrom = -1;
    for (let i = 0; i < work.length; i++) {
      const firstLines = work[i].text.split("\n").slice(0, 3).map((l) => l.trim());
      if (firstLines.some((l) => HEADINGS.test(l) || HEADINGS_AR.test(l))) {
        const rest = work.slice(i);
        const restRatio =
          rest.reduce((n, p) => n + apparatusRatio(p.text) * p.text.length, 0) /
          Math.max(1, rest.reduce((n, p) => n + p.text.length, 0));
        if (restRatio >= APPARATUS_RATIO * 0.7) {
          cutFrom = i;
          break;
        }
      }
    }

    work = work.filter((p, i) => {
      const isTail = cutFrom >= 0 && i >= cutFrom;
      const isDense = apparatusRatio(p.text) >= APPARATUS_RATIO;
      if (isTail || isDense) {
        apparatusPieces++;
        apparatusChars += p.text.length;
        return false;
      }
      return true;
    });

    // Endnotes are usually printed at the foot of a page that is mostly prose,
    // so dropping whole pages leaves most of them behind. Within the pages we
    // keep, remove *runs* of citation lines: three or more in a row is a note
    // block, whereas an argument that happens to cite something is one line at
    // a time and survives.
    work = work.map((p) => {
      const lines = p.text.split("\n");
      const drop = new Set<number>();
      let runStart = -1;

      const closeRun = (end: number) => {
        if (runStart >= 0 && end - runStart >= 3) {
          for (let k = runStart; k < end; k++) drop.add(k);
        }
        runStart = -1;
      };

      lines.forEach((line, idx) => {
        const t = line.trim();
        if (!t) return; // blank lines neither start nor break a run
        if (citationScore(t)) {
          if (runStart < 0) runStart = idx;
        } else {
          closeRun(idx);
        }
      });
      closeRun(lines.length);

      if (drop.size === 0) return p;
      const kept = lines.filter((_, idx) => !drop.has(idx));
      apparatusChars += p.text.length - kept.join("\n").length;
      return { ...p, text: kept.join("\n") };
    });
  }

  // --- always worth doing ---------------------------------------------------
  work = work
    .map((p) => ({ ...p, text: tidy(p.text) }))
    .filter((p) => p.text.trim().length > 0);

  const charsAfter = work.reduce((n, p) => n + p.text.length, 0);

  return {
    pieces: work,
    dropped: {
      apparatusPieces,
      apparatusChars,
      furnitureLines,
      charsBefore,
      charsAfter,
      tokensSaved: Math.max(0, estimateTokens("x".repeat(charsBefore)) - estimateTokens("x".repeat(charsAfter))),
    },
  };
}

/**
 * Lines appearing on many pages at the same place are the book's furniture —
 * running heads, the author's name, the journal title. Requiring several
 * occurrences keeps a genuinely repeated sentence from being mistaken for one.
 */
function repeatedLines(pieces: Piece[]): Set<string> {
  if (pieces.length < 5) return new Set();

  const counts = new Map<string, number>();
  for (const p of pieces) {
    // Only the top and bottom of a page carry furniture.
    const lines = p.text.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const l of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      if (l.length > 3 && l.length < 90) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
  }

  const threshold = Math.max(4, Math.floor(pieces.length * 0.25));
  return new Set([...counts.entries()].filter(([, n]) => n >= threshold).map(([l]) => l));
}

function isPageNumber(line: string): boolean {
  return /^[-–—\s|[\]()]*\d{1,4}[-–—\s|[\]()]*$/.test(line) && line.trim().length < 10;
}

function tidy(text: string): string {
  return (
    text
      // A word split across a line break by hyphenation.
      .replace(/([\p{Ll}])[-­]\s*\n\s*([\p{Ll}])/gu, "$1$2")
      // Ligatures pdfjs sometimes leaves behind.
      .replace(/ﬁ/g, "fi")
      .replace(/ﬂ/g, "fl")
      // Soft hyphens and zero-width junk.
      .replace(/[­​‌‎‏﻿]/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** A human summary of what was skipped, for the Library. */
export function describeSaving(d: CleanResult["dropped"]): string {
  if (d.charsBefore === 0) return "";
  const pct = Math.round(((d.charsBefore - d.charsAfter) / d.charsBefore) * 100);
  if (pct < 2) return "";
  const bits: string[] = [];
  if (d.apparatusPieces > 0) {
    bits.push(`${d.apparatusPieces} section${d.apparatusPieces === 1 ? "" : "s"} of notes and references`);
  }
  if (d.furnitureLines > 20) bits.push(`${d.furnitureLines} lines of running heads and page numbers`);
  const what = bits.length ? bits.join(" and ") : "boilerplate";
  return `Skipped ${what} — ${pct}% less text, about ${d.tokensSaved.toLocaleString()} tokens you won't spend.`;
}
