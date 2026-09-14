import type { Piece } from "../chunk";

export interface PdfParse {
  pieces: Piece[];
  /** 1-based pages with no extractable text — these are scans and need OCR. */
  scannedPages: number[];
  pageCount: number;
  meta: { title?: string; author?: string };
}

/**
 * Born-digital PDFs, read without a model, with the page furniture left out.
 *
 * pdfjs hands back positioned fragments. Those are assembled into lines, and
 * then into the book's own prose: running heads and folios removed, footnotes
 * lifted out of the body, citation numbers kept on their sentences, headings
 * and paragraphs found from the type and the spacing, and a sentence the page
 * broke off joined to its end. The method is Mutarjim's, which proved it on
 * real books (a body cut-sentence rate from 4.9% to 0.54%); what is different
 * here is noted where it happens — Arabic-Indic folios, bracketed and "Page n
 * of m" folios, and a roman-numeral test that does not eat the word CIVIL.
 *
 * Pages stay pieces, one each, because a citation names a page. A paragraph
 * that runs across a page break is kept whole on the page where it began.
 */

/** Below this, a page is assumed to be an image rather than text. Running
 *  headers and page numbers alone clear about 30 characters. */
const TEXT_THRESHOLD = 120;

/** Around a raised citation number, so nothing below mistakes it for a folio. */
const MARK_OPEN = "";
const MARK_CLOSE = "";
const MARKED = /(\d{1,3})/g;

/** Digits a folio may be printed in: ASCII, Arabic-Indic, and the Persian forms. */
const DIGIT = "0-9٠-٩۰-۹";
const FOLIO = new RegExp(`^[${DIGIT}\\s.·•\\-–—()\\[\\]|/]*$`);
const PAGE_OF = new RegExp(
  `^(?:(?:page|pg\\.?|p\\.|صفحة|ص\\.?)\\s*)?[${DIGIT}]+(?:\\s*(?:of|/|من)\\s*[${DIGIT}]+)?$`,
  "i"
);
/** A roman numeral that is actually one — "xiv", not "civil" or "mix". */
const ROMAN = /^(?=[mdclxvi])m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;
/** How a finished sentence or clause ends, in either script. */
const TERMINAL = /[.!?؟؛:"”»…)\]]$/;

export async function parsePdf(bytes: Buffer): Promise<PdfParse> {
  // The legacy build is the one that runs outside a browser.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
    // Worker threads buy nothing here and complain in Node.
    disableFontFace: true,
  }).promise;

  const scannedPages: number[] = [];
  const textPages: { page: number; lines: PdfLine[] }[] = [];

  let meta: { title?: string; author?: string } = {};
  try {
    const info = (await doc.getMetadata()).info as { Title?: string; Author?: string };
    meta = { title: info?.Title || undefined, author: info?.Author || undefined };
  } catch {
    /* metadata is optional */
  }

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const items = content.items as TextItem[];
    page.cleanup();

    // Measured before anything is removed: a page holding only a running
    // head and a folio is still a scan of everything else.
    if (items.map((i) => i.str ?? "").join("").trim().length < TEXT_THRESHOLD) {
      scannedPages.push(n);
      continue;
    }
    textPages.push({ page: n, lines: assembleLines(items) });
  }

  const pageCount = doc.numPages;
  await doc.destroy();
  return { pieces: layoutPages(textPages), scannedPages, pageCount, meta };
}

interface TextItem {
  str: string;
  hasEOL?: boolean;
  transform?: number[];
  height?: number;
}

/** A line as the fragments make it: where it starts, how large its type is, what it says. */
export interface PdfLine {
  x: number;
  y: number;
  size: number;
  text: string;
}

interface Para {
  text: string;
  /** 0 for prose; 2 or 3 for a heading, by how much larger than the body it is. */
  heading: 0 | 2 | 3;
}

/**
 * Fragments into lines, on the Y coordinate, in the order the page drew them.
 *
 * A digit of one to three characters in type well below the page's usual size
 * is a raised citation number, and is wrapped so the folio test cannot delete
 * it — it belongs to the sentence it is raised beside.
 */
export function assembleLines(items: TextItem[]): PdfLine[] {
  const lines: { x: number; y: number; size: number; parts: { text: string; size: number }[] }[] = [];

  for (const item of items) {
    if (!item.str) continue;
    const x = item.transform ? item.transform[4] : 0;
    const y = item.transform ? Math.round(item.transform[5]) : 0;
    const size = item.height ?? (item.transform ? Math.abs(item.transform[3]) : 0);
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - y) <= 2) {
      last.parts.push({ text: item.str, size });
      last.size = Math.max(last.size, size);
      last.x = Math.min(last.x, x);
    } else {
      lines.push({ x, y, size, parts: [{ text: item.str, size }] });
    }
  }

  const typical = mode(lines.flatMap((l) => l.parts.map((p) => Math.round(p.size))));
  if (typical > 0) {
    for (const l of lines) {
      for (const p of l.parts) {
        if (p.size && p.size <= typical * 0.75 && /^\s*\d{1,3}\s*$/.test(p.text)) {
          p.text = `${MARK_OPEN}${p.text.trim()}${MARK_CLOSE}`;
        }
      }
    }
  }

  return lines
    .map((l) => ({ x: l.x, y: l.y, size: l.size, text: cleanLine(l.parts.map((p) => p.text).join("")) }))
    .filter((l) => l.text);
}

/**
 * One line, with what is never prose taken out: contents-page dot leaders,
 * and a line that is only a page number — in any digits, in dashes or
 * brackets, as "Page 3 of 10", or as a roman numeral. A single capital is a
 * drop cap, not a folio.
 */
export function cleanLine(raw: string): string {
  let text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text.replace(/(?:\.\s?){4,}/g, " ").replace(/\s+/g, " ").trim();
  if (text.includes(MARK_OPEN)) return text;
  if (FOLIO.test(text) || PAGE_OF.test(text)) return "";
  const letters = text.replace(/[^a-z]/gi, "");
  if (
    letters.length > 0 &&
    letters.length <= 7 &&
    /^[ivxlcdm\s.\-–—()[\]]+$/i.test(text) &&
    ROMAN.test(letters) &&
    !(letters.length === 1 && letters === letters.toUpperCase())
  ) {
    return "";
  }
  return text;
}

/** A line reduced to what a running head keeps from page to page: its letters, with any number gone. */
export function furnitureKey(text: string): string {
  return text
    .replace(/\d*/g, "")
    .toLowerCase()
    .replace(/[\p{N}\s\p{P}\p{S}]+/gu, "");
}

/** Shorter than this, a repeated edge line is as likely a word of prose ("Yes.") as a running head. */
const MIN_FURNITURE_KEY = 4;

/**
 * Running heads and feet: the same line, numbers aside, at the top or bottom
 * of page after page.
 *
 * Only the first two and last two lines of a page are candidates, and a line
 * is furniture once it has sat there on three pages — four in a document of
 * thirteen pages or more — and never more than four, however long the book:
 * a chapter's own running head repeats only through its chapter, so a share
 * of the whole book would never catch it. Prose does not put the same words at
 * a page edge four times.
 */
export function detectFurniture(pages: PdfLine[][]): Set<string> {
  const withText = pages.filter((p) => p.length > 0);
  const found = new Set<string>();
  if (withText.length < 3) return found;

  const counts = new Map<string, number>();
  for (const lines of withText) {
    const seen = new Set<string>();
    for (const l of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      const key = furnitureKey(l.text);
      if (key.length < MIN_FURNITURE_KEY || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const threshold = Math.min(Math.max(3, Math.ceil(withText.length * 0.25)), 4);
  for (const [key, n] of counts) if (n >= threshold) found.add(key);
  return found;
}

/** A line's text without its citation-number wrapping. */
const bare = (t: string) => t.replace(/[]/g, "");
/** A paragraph's text without its citation numbers, for asking how it ends. */
const unmarked = (t: string) => t.replace(MARKED, "").trim();

/**
 * Joins two pieces of prose that a line or a page broke apart. A word split
 * by a hyphen at the break is mended when the next piece carries on in lower
 * case, in any script that has case.
 */
export function joinCut(a: string, b: string): string {
  if (/\p{L}[-­]$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}

/**
 * One page's lines into its prose and its notes.
 *
 * Furniture is removed only where it was found — at the page's edges; the
 * same words in the middle of a page are the book talking about itself.
 * Type below the body size is not body text: a small number beside a body
 * line is a citation mark and rejoins that line, anything else is a note (or
 * a small running head that slipped past), gathered after the prose so it
 * never sits between a sentence and its end.
 */
export function buildPage(input: PdfLine[], furniture: Set<string>): { body: Para[]; feet: string[] } {
  const lines = input
    .filter((l, i) => !((i < 2 || i >= input.length - 2) && furniture.has(furnitureKey(l.text))))
    .map((l) => ({ ...l }));
  if (!lines.length) return { body: [], feet: [] };

  const bodySize = mode(lines.map((l) => Math.round(l.size)));
  const isFoot = (l: PdfLine) => bodySize > 0 && l.size <= bodySize * 0.85;
  const numeric = (l: PdfLine) => /^[\s([]*\d{1,3}[\s)\].]*$/.test(bare(l.text));
  const smalls = lines.filter(isFoot);
  const bodyLines = lines.filter((l) => !isFoot(l));

  const markers = new Set<PdfLine>();
  for (const l of smalls) {
    if (!numeric(l) || !bodyLines.length) continue;
    const distance = (pool: PdfLine[]) => pool.reduce((best, o) => Math.min(best, Math.abs(o.y - l.y)), Infinity);
    const toBody = distance(bodyLines);
    if (toBody <= bodySize * 1.2 && toBody < distance(smalls.filter((s) => s !== l && !numeric(s)))) {
      markers.add(l);
      const host = bodyLines.reduce((best, o) => (Math.abs(o.y - l.y) < Math.abs(best.y - l.y) ? o : best));
      host.text = `${host.text}${MARK_OPEN}${bare(l.text).replace(/\D/g, "")}${MARK_CLOSE}`;
    }
  }

  const isHeading = (l: PdfLine) =>
    bodySize > 0 && l.size >= bodySize * 1.15 && bare(l.text).length < 90 && !/[.!?؟]$/.test(bare(l.text));

  // The ordinary distance from one line to the next; a paragraph is a wider one.
  const gaps: number[] = [];
  for (let i = 1; i < bodyLines.length; i++) {
    const g = Math.abs(bodyLines[i - 1].y - bodyLines[i].y);
    if (g > 2) gaps.push(g);
  }
  const spacing = Math.max(gaps.length ? Math.min(...gaps) : 0, bodySize);

  const body: Para[] = [];
  let text = "";
  let prev: PdfLine | null = null;
  let dropCap = "";

  const flush = () => {
    if (text) {
      // Prose that starts in lower case is the rest of the paragraph before
      // it — even when that was taken for a heading.
      const before = body[body.length - 1];
      if (before && /^\p{Ll}/u.test(bare(text))) {
        before.text = joinCut(before.text, text);
        before.heading = 0;
      } else {
        body.push({ text, heading: 0 });
      }
    }
    text = "";
    prev = null;
  };

  for (const line of bodyLines) {
    if (isHeading(line)) {
      flush();
      // A letter or two in large type is a drop cap: the start of the paragraph.
      if (bare(line.text).replace(/[^\p{L}\p{N}]/gu, "").length <= 2) {
        dropCap = bare(line.text).trim();
      } else {
        body.push({ text: line.text, heading: line.size >= bodySize * 1.4 ? 2 : 3 });
      }
      continue;
    }
    if (text && prev) {
      const gap = Math.abs(prev.y - line.y);
      // An indent after a finished sentence, measured from the line above rather
      // than the margin, so an indented quotation is not cut line by line.
      const indented = line.x - prev.x > bodySize * 0.8 && TERMINAL.test(unmarked(prev.text));
      if (gap > spacing * 1.7 || indented) flush();
    }
    if (!text) {
      text = dropCap ? dropCap + line.text : line.text;
      dropCap = "";
    } else {
      text = joinCut(text, line.text);
    }
    prev = line;
  }
  flush();
  if (dropCap) body.push({ text: dropCap, heading: 0 });

  const feet: string[] = [];
  for (const l of smalls) {
    if (markers.has(l)) continue;
    if (!feet.length || /^\d{1,3}[\s.)]/.test(bare(l.text))) feet.push(l.text);
    else feet[feet.length - 1] = joinCut(feet[feet.length - 1], l.text);
  }
  return { body, feet };
}

/**
 * Every page's prose and notes, with the sentences the pages broke off joined
 * to their ends. A paragraph is carried over when the last one on a page is
 * long enough to be prose and does not end as a sentence does; it takes the
 * first paragraph of the next page that is not a heading, and a page in
 * between that carried no prose of its own passes it along.
 */
export function layoutPages(pages: { page: number; lines: PdfLine[] }[]): Piece[] {
  const furniture = detectFurniture(pages.map((p) => p.lines));
  const built = pages.map((p) => ({ page: p.page, ...buildPage(p.lines, furniture) }));

  let open: Para | null = null;
  let previousPage = -10;
  for (const p of built) {
    if (open && p.page === previousPage + 1) {
      const at = p.body.findIndex((b) => !b.heading);
      if (at >= 0) {
        open.text = joinCut(open.text, p.body[at].text);
        p.body.splice(at, 1);
      }
    } else {
      open = null;
    }
    const last = p.body[p.body.length - 1];
    const candidate: Para | null = last ? (last.heading ? null : last) : open;
    open =
      candidate && unmarked(candidate.text).length >= 40 && !TERMINAL.test(unmarked(candidate.text)) ? candidate : null;
    previousPage = p.page;
  }

  const pieces: Piece[] = [];
  for (const p of built) {
    const text = [...p.body.map((b) => (b.heading ? `${"#".repeat(b.heading)} ${b.text}` : b.text)), ...p.feet]
      .map((t) => t.replace(MARKED, "$1").replace(/[]/g, "").trim())
      .filter(Boolean)
      .join("\n\n");
    if (text) pieces.push({ text, label: `p. ${p.page}`, locator: { page: p.page } });
  }
  return pieces;
}

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) if (v > 0) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = 0;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) [best, bestN] = [v, n];
  return best;
}
