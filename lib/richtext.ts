import type { DocxBlock, DocxNote, DocxRun } from "./docx";

/**
 * The editor's HTML, turned into something Word can be given.
 *
 * The editor stores HTML because that is what a contenteditable region
 * produces and what round-trips through it without loss. This is the one place
 * that HTML is interpreted, and it is deliberately a *small* interpretation: a
 * handful of block types, bold, italic, and citations. Anything else — a colour
 * pasted in from a web page, a nested table, a font — is dropped rather than
 * approximated, because a research document that quietly changes appearance
 * between the screen and the exported file is worse than a plain one.
 *
 * Written as a hand parser rather than with a DOM library because this runs on
 * the server, where there is no DOM, and because the input is not arbitrary web
 * HTML: it is what our own editor emits.
 */

export interface Citation {
  /** The rendered note, e.g. "Wald, Saudi, Inc., 2018, p. 142." */
  text: string;
  /** The source's own address, when it has one: the exported footnote ends
   *  in a link to it. */
  url?: string | null;
}

const BLOCK_TAGS = /^(p|h1|h2|h3|blockquote|li|div)$/i;

interface Token {
  tag: string;
  attrs: string;
  closing: boolean;
  selfClosing: boolean;
}

/** Splits HTML into text and tags. Good enough for the markup we emit. */
function* lex(html: string): Generator<{ text?: string; token?: Token }> {
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m.index > last) yield { text: html.slice(last, m.index) };
    yield {
      token: {
        closing: m[1] === "/",
        tag: m[2].toLowerCase(),
        attrs: m[3] ?? "",
        selfClosing: m[4] === "/",
      },
    };
    last = m.index + m[0].length;
  }
  if (last < html.length) yield { text: html.slice(last) };
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Turns the editor's HTML into Word blocks plus the notes they refer to.
 *
 * Citations are carried in the markup as `<span data-note="3">`, an index into
 * the draft's citation list — the note text is not written into the document
 * body, so editing a citation updates every place it appears rather than the
 * first one you happen to find.
 */
export function htmlToDocx(
  html: string,
  citations: Citation[]
): { blocks: DocxBlock[]; notes: DocxNote[] } {
  const blocks: DocxBlock[] = [];
  const notes: DocxNote[] = [];
  /** Citation index → note index, so one source cited twice is one footnote. */
  const noteOf = new Map<number, number>();

  let kind: DocxBlock["kind"] = "paragraph";
  let level: 1 | 2 | 3 = 1;
  let runs: DocxRun[] = [];
  let bold = 0;
  let italic = 0;
  let listKind: "bullet" | "number" = "bullet";

  const flush = () => {
    const meaningful = runs.filter((r) => r.note !== undefined || (r.text ?? "").trim() !== "");
    if (meaningful.length) {
      blocks.push(
        kind === "heading"
          ? { kind: "heading", level, runs }
          : ({ kind, runs } as DocxBlock)
      );
    }
    runs = [];
    kind = "paragraph";
  };

  /**
   * True while inside a citation marker.
   *
   * The marker's visible text is the number the editor drew — "[1]" — and Word
   * draws its own footnote number, so it has to be dropped or every citation
   * exports as "[1]¹".
   */
  let insideMarker = false;

  for (const part of lex(html)) {
    if (part.text !== undefined) {
      if (insideMarker) continue;
      const text = decode(part.text);
      if (text) runs.push({ text, bold: bold > 0, italic: italic > 0 });
      continue;
    }
    const t = part.token!;

    if (t.tag === "br" && !t.closing) {
      flush();
      continue;
    }

    if (BLOCK_TAGS.test(t.tag)) {
      if (t.closing) {
        flush();
      } else {
        flush();
        if (t.tag === "h1") (kind = "heading"), (level = 1);
        else if (t.tag === "h2") (kind = "heading"), (level = 2);
        else if (t.tag === "h3") (kind = "heading"), (level = 3);
        else if (t.tag === "blockquote") kind = "quote";
        else if (t.tag === "li") kind = listKind;
        else kind = "paragraph";
      }
      continue;
    }

    if (t.tag === "ul") listKind = "bullet";
    if (t.tag === "ol") listKind = "number";

    if (t.tag === "b" || t.tag === "strong") bold += t.closing ? -1 : 1;
    if (t.tag === "i" || t.tag === "em") italic += t.closing ? -1 : 1;

    // A citation marker becomes a real footnote at this point in the text.
    if (t.tag === "span") {
      if (t.closing) {
        insideMarker = false;
      } else {
        const m = /data-note="(\d+)"/.exec(t.attrs);
        if (m) {
          insideMarker = true;
          const index = Number(m[1]);
          const citation = citations[index];
          if (citation) {
            // One source cited three times is one footnote referenced three
            // times, which is what a reader expects and what Word does natively.
            let note = noteOf.get(index);
            if (note === undefined) {
              note = notes.length;
              notes.push({ text: citation.text, url: citation.url ?? null });
              noteOf.set(index, note);
            }
            runs.push({ note });
          }
        }
      }
    }
  }

  flush();
  return { blocks, notes };
}

/**
 * Strips the editor's HTML back to plain text.
 *
 * Used by the fact-check, which reads what you wrote rather than how it looks,
 * and by the word count.
 */
export function htmlToText(html: string): string {
  let out = "";
  for (const part of lex(html)) {
    if (part.text !== undefined) out += decode(part.text);
    else if (part.token && BLOCK_TAGS.test(part.token.tag) && part.token.closing) out += "\n\n";
    else if (part.token?.tag === "br") out += "\n";
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
