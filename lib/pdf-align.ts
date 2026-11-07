/**
 * Finding the book's paragraphs on the PDF's own pages.
 *
 * The reader reads paragraphs: reading mode lights one, the voice reads one,
 * progress counts them. Those paragraphs are Raazi's extraction of the PDF —
 * cleaned, de-hyphenated, with running heads and page numbers taken out, and
 * packed into passages that run across several pages. The page view draws the
 * PDF as it is. To light a paragraph there, each one has to be found among the
 * text pdf.js reports for the pages, which is the same words in a messier
 * shape: split into runs, broken across lines and pages, with the heads and
 * folios still in, and Arabic sometimes in presentation forms.
 *
 * So both sides are reduced to letters and digits only — no spaces, no
 * punctuation, no diacritics, one form of each Arabic letter — and the
 * paragraphs are found in order along the whole book, each starting its search
 * where the last one ended. What survives that reduction is the same on both
 * sides however the line was broken, which is what makes a plain substring
 * search enough.
 *
 * Nothing here knows about the DOM or pdf.js; it works on strings, so it can be
 * tested without a browser.
 */

/** Text reduced for matching, and where each of its characters came from. */
export interface Folded {
  text: string;
  /** For each character of `text`, its index in the original string. */
  map: number[];
}

const ARABIC_DIGIT = /[٠-٩۰-۹]/;

/**
 * Letters and digits only, lower case, without marks, and with the Arabic
 * spellings that vary between a PDF's text and its extraction made one.
 *
 * NFKD does most of it: presentation forms become plain letters, a hamza or
 * madda on an alef comes apart into the alef and a mark, and ligatures split.
 */
export function fold(raw: string): Folded {
  let text = "";
  const map: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    let ch = raw[i];
    // A surrogate pair is one character, and never one we keep.
    const code = raw.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      i++;
      continue;
    }
    if (ARABIC_DIGIT.test(ch)) {
      const c = ch.charCodeAt(0);
      ch = String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
    }
    for (let out of ch.normalize("NFKD")) {
      if (!/[\p{L}\p{N}]/u.test(out)) continue;
      if (out === "ـ") continue; // tatweel, a stretch rather than a letter
      if (out === "ة") out = "ه";
      else if (out === "ى") out = "ي";
      text += out.toLowerCase();
      map.push(i);
    }
  }
  return { text, map };
}

/** A paragraph's place on one page: the first and last text run it covers there. */
export interface Part {
  /** 0-based page index. */
  page: number;
  /** First and last item (pdf.js text run) on that page, inclusive. */
  from: number;
  to: number;
}

/**
 * The whole book's text as pdf.js reports it, folded, with each character
 * traced back to its page and run.
 */
export interface BookText {
  text: string;
  page: Int32Array;
  item: Int32Array;
  /** Where each page starts in `text`. */
  pageStart: number[];
}

export function bookText(pages: string[][]): BookText {
  let text = "";
  const pageOf: number[] = [];
  const itemOf: number[] = [];
  const pageStart: number[] = [];
  pages.forEach((items, p) => {
    pageStart.push(text.length);
    items.forEach((s, it) => {
      const f = fold(s);
      text += f.text;
      for (let k = 0; k < f.text.length; k++) {
        pageOf.push(p);
        itemOf.push(it);
      }
    });
  });
  return { text, page: Int32Array.from(pageOf), item: Int32Array.from(itemOf), pageStart };
}

const ANCHOR = 28;

/** A paragraph to find, and the pages its passage says it is on. */
export interface Wanted {
  text: string;
  /** 1-based page its passage starts on, when known. */
  page?: number | null;
  /** 1-based page the next passage starts on, when known — about where this one ends. */
  until?: number | null;
}

/** Pages either side of a passage's own that a paragraph may still be found on. */
const SLACK_BEFORE = 1;
const SLACK_AFTER = 2;

/**
 * Where each paragraph is, or null for one that could not be found.
 *
 * Each paragraph is looked for only on the pages its passage covers — every
 * passage records the page it starts on — and, within those, from where the
 * paragraph before it ended. Two earlier versions searched the whole book and
 * both failed on real books:
 *
 * - A walk from the front matched the first chapter title in the contents,
 *   the next in the chapter itself a hundred pages on, and searched for
 *   everything in between behind the place it had already passed.
 * - The longest run of matches in book order fixed that, but not a book whose
 *   stored text is in another order from its pages — an essay collection had
 *   two hundred and fifty paragraphs whose pages come before the ones the
 *   extraction put ahead of them, and one consistent order had to drop them.
 *
 * The passage's page settles both: the contents page is not near the chapter,
 * and a passage is on its own pages whatever order the passages come in.
 * Within a passage, a paragraph not found after the last one is looked for
 * from the passage's first page again, so a page whose columns or notes came
 * out in a different order still finds its paragraphs.
 */
export function align(book: BookText, paragraphs: Wanted[]): (Part[] | null)[] {
  const G = book.text;
  const pages = book.pageStart.length;
  const at = (page: number) => (page >= pages ? G.length : book.pageStart[Math.max(0, page)]);
  const out: (Part[] | null)[] = [];
  let cursor = 0;
  /**
   * How far the book's pages are from the pages its passages name. Zero for
   * anything read by the current extraction; not for every source — one book
   * here names its printed folios, twenty-one pages behind the file's own.
   * Learned from each paragraph found, so one offset found early carries the
   * rest of the book.
   */
  let shift = 0;

  for (const want of paragraphs) {
    const p = fold(want.text).text;
    if (p.length < 3) {
      out.push(null);
      continue;
    }

    let start: number | null = null;
    let hi = G.length;
    /** Whether where it was found says anything about the book's offset. */
    let telling = false;

    // The passage's pages, with a little either side: moved by the offset
    // learned so far, and then as named, in case that offset was wrong here.
    if (want.page) {
      for (const by of shift ? [shift, 0] : [0]) {
        const last = Math.max(want.page, want.until ?? want.page) - 1 + SLACK_AFTER + by;
        const own = at(want.page - 1 + by);
        const lo = at(want.page - 1 - SLACK_BEFORE + by);
        hi = at(last + 1);
        const from = cursor >= own && cursor < hi ? cursor : own;
        // After the last paragraph; then from the passage's own first page;
        // only then the page before it, which is where a contents page sits.
        start =
          find(G, p, from, hi) ??
          (from > own ? find(G, p, own, hi) : null) ??
          (own > lo ? find(G, p, lo, hi) : null);
        if (start !== null) {
          telling = true;
          break;
        }
      }
    }
    // Carrying on from the last paragraph found, over the next few pages.
    if (start === null) {
      const page = cursor < G.length ? book.page[cursor] : pages - 1;
      hi = at(page + 6);
      start = find(G, p, cursor, hi);
    }
    // Anywhere, but only where it is unmistakable: a long paragraph whose
    // opening occurs once in the whole book.
    if (start === null && p.length >= 40) {
      start = unique(G, p);
      hi = G.length;
      telling = start !== null;
    }
    if (start === null) {
      out.push(null);
      continue;
    }

    const end = endOf(G, p, start, hi);
    if (end <= start) {
      out.push(null);
      continue;
    }
    out.push(partsOf(book, start, end));
    cursor = end;
    if (want.page && telling) shift = book.page[start] + 1 - want.page;
  }
  return out;
}

/** Where a paragraph is, when one of its anchors occurs exactly once in the book. */
function unique(G: string, p: string): number | null {
  for (const o of headOffsets(p.length)) {
    const anchor = p.slice(o, o + ANCHOR);
    const first = G.indexOf(anchor);
    if (first >= 0 && G.indexOf(anchor, first + 1) < 0) return Math.max(0, first - o);
  }
  return null;
}

/** The first place in [from, to) the paragraph's opening — or failing that, a later part of it — is. */
function find(G: string, p: string, from: number, to: number): number | null {
  for (const o of headOffsets(p.length)) {
    const anchor = p.slice(o, o + ANCHOR);
    const found = G.indexOf(anchor, from);
    if (found >= 0 && found + anchor.length <= to) return Math.max(from, found - o);
  }
  return null;
}

/** Where a paragraph found at `start` ends: at its closing words, before `limit`. */
function endOf(G: string, p: string, start: number, limit: number): number {
  const furthest = Math.min(limit, start + p.length * 2 + 3000);
  for (const o of tailOffsets(p.length)) {
    const anchor = p.slice(Math.max(0, p.length - o - ANCHOR), p.length - o);
    const found = G.indexOf(anchor, start);
    if (found >= 0 && found + anchor.length <= furthest) return Math.min(G.length, found + anchor.length + o);
  }
  return Math.min(furthest, start + p.length);
}

function headOffsets(n: number): number[] {
  if (n <= ANCHOR) return [0];
  const offs = [0, 12, 40, Math.floor(n / 3), Math.floor(n / 2)];
  return [...new Set(offs.filter((o) => o + ANCHOR <= n))];
}

function tailOffsets(n: number): number[] {
  if (n <= ANCHOR) return [0];
  const offs = [0, 12, 40, Math.floor(n / 3)];
  return [...new Set(offs.filter((o) => o + ANCHOR <= n))];
}

/** A range of the book's folded text as the runs it covers, page by page. */
function partsOf(book: BookText, start: number, end: number): Part[] {
  const parts: Part[] = [];
  let k = start;
  while (k < end) {
    const page = book.page[k];
    const pageEnd = Math.min(end, book.pageStart[page + 1] ?? book.text.length);
    parts.push({ page, from: book.item[k], to: book.item[pageEnd - 1] });
    k = pageEnd;
  }
  return parts;
}

/**
 * Finds a selection made on the page in the extracted text, and returns the
 * extracted words.
 *
 * What the browser hands back from a PDF's text layer is the page's text as
 * pdf.js laid it out: a line break at every line end, a hyphen at every broken
 * word, sometimes a folio in the middle. What goes to the writing desk should be
 * the paragraph as Raazi reads it. So the selection is folded, found in the
 * extracted text by its opening and its close, and the extracted text between
 * the two is what is returned — together with the paragraph it began in.
 */
export function findSelection(
  selected: string,
  paragraphs: string[]
): { text: string; paragraph: number } | null {
  const s = fold(selected).text;
  if (s.length < 3 || !paragraphs.length) return null;

  const joined = paragraphs.join("\n\n");
  const f = fold(joined);
  const head = s.slice(0, Math.min(s.length, ANCHOR));
  const a = f.text.indexOf(head);
  if (a < 0) return null;
  const tail = s.slice(Math.max(0, s.length - ANCHOR));
  const b = f.text.indexOf(tail, a + Math.max(0, s.length - ANCHOR));
  if (b < 0) return null;
  const endFolded = b + tail.length;
  // The selection and what was found should be about the same length; a tail
  // found three pages on is a different occurrence of the same words.
  if (endFolded - a > s.length * 1.5 + 40) return null;

  const rawStart = f.map[a];
  let rawEnd = f.map[endFolded - 1] + 1;
  // Keep the punctuation that closes the last word.
  while (rawEnd < joined.length && /[.,;:!?؟،؛)\]»"”'’…]/.test(joined[rawEnd])) rawEnd++;
  const text = joined.slice(rawStart, rawEnd).replace(/\s*\n\s*\n\s*/g, "\n\n").trim();

  let paragraph = 0;
  let seen = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    if (rawStart < seen + paragraphs[i].length + 2) {
      paragraph = i;
      break;
    }
    seen += paragraphs[i].length + 2;
  }
  return { text, paragraph };
}

/**
 * The selection as typed text, for when it cannot be found in the extraction:
 * lines joined, words broken at a line end mended, presentation forms undone.
 */
export function tidySelection(selected: string): string {
  return selected
    .normalize("NFKC")
    .replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, "$1$2")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
