import type { Locator } from "./types";

/** Gemini bills real tokens; this is only for sizing windows and estimates.
 *  ~4 chars/token holds for English; Arabic runs denser, so we bias down. */
export function estimateTokens(text: string): number {
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length;
  const ratio = arabic > text.length * 0.3 ? 2.5 : 4;
  return Math.ceil(text.length / ratio);
}

export interface Piece {
  /** Text of one natural unit — a page, a chapter, a transcript segment. */
  text: string;
  locator: Locator;
  /** Document label this piece belongs to, e.g. "Chapter 3" or "p. 142". */
  label: string;
}

export interface BuiltChunk {
  text: string;
  tokenEst: number;
  locator: Locator;
  label: string;
}

const TARGET_TOKENS = 3500;
const OVERLAP_TOKENS = 250;

/**
 * Packs pieces into ~3,500-token windows, never splitting a paragraph, and
 * carries a tail of the previous window forward so a sentence spanning the
 * seam is still readable in context. The locator of a window is the locator of
 * the piece it starts in — that is what a citation will point at.
 */
export function buildChunks(pieces: Piece[]): BuiltChunk[] {
  const out: BuiltChunk[] = [];
  let buf: string[] = [];
  let bufTokens = 0;
  let start: Piece | null = null;

  const flush = () => {
    if (!buf.length || !start) return;
    const text = buf.join("\n\n").trim();
    if (text) {
      out.push({
        text,
        tokenEst: estimateTokens(text),
        locator: start.locator,
        label: start.label,
      });
    }
    // Carry the tail forward as overlap.
    const tail = takeTail(text, OVERLAP_TOKENS);
    buf = tail ? [tail] : [];
    bufTokens = tail ? estimateTokens(tail) : 0;
    start = null;
  };

  for (const piece of pieces) {
    for (const para of splitParagraphs(piece.text)) {
      const t = estimateTokens(para);

      // A single monster paragraph gets hard-split rather than blowing the window.
      if (t > TARGET_TOKENS) {
        flush();
        for (const part of hardSplit(para, TARGET_TOKENS)) {
          out.push({
            text: part,
            tokenEst: estimateTokens(part),
            locator: piece.locator,
            label: piece.label,
          });
        }
        continue;
      }

      if (bufTokens + t > TARGET_TOKENS) flush();
      if (!start) start = piece;
      buf.push(para);
      bufTokens += t;
    }
  }
  flush();
  // The final flush leaves the overlap tail behind; drop it.
  return out;
}

function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function takeTail(text: string, tokens: number): string {
  const chars = tokens * 4;
  if (text.length <= chars) return "";
  const slice = text.slice(-chars);
  const at = slice.search(/[.!?؟।]\s/);
  return at >= 0 ? slice.slice(at + 2).trim() : slice.trim();
}

function hardSplit(text: string, tokens: number): string[] {
  const chars = tokens * 4;
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + chars, text.length);
    if (end < text.length) {
      // Prefer a sentence boundary in the last 20% of the window.
      const window = text.slice(i, end);
      const at = window.lastIndexOf(". ");
      if (at > chars * 0.8) end = i + at + 1;
    }
    out.push(text.slice(i, end).trim());
    i = end;
  }
  return out.filter(Boolean);
}

/** Human-readable citation locator: "p. 142", "Chapter 3", "00:34:12". */
export function formatLocator(loc: Locator, label?: string | null): string {
  if (loc.page) return `p. ${loc.page}`;
  if (loc.timecode) return loc.timecode;
  if (loc.chapter) return loc.chapter;
  return label ?? "";
}
