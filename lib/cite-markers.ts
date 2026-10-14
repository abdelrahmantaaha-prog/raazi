/**
 * Citation markers in a draft's HTML: the one grammar the editor, the server
 * and the Word export agree on.
 *
 * A marker is `<span data-cite="ID" data-note="I" contenteditable="false">[n]</span>`:
 *
 * - `data-cite` is the reference's own id, and the only thing that says which
 *   reference a marker points at. Everything else is derived from it.
 * - `[n]` is the number the reader sees, and it is the marker's place in the
 *   order references are *first cited in the text* — the order Word numbers
 *   footnotes in. It used to be the order references were added to the list,
 *   so a draft could read "[2] … [1]" on screen and "1 … 2" in the export.
 * - `data-note` is the reference's index in the stored list (by `seq`). Newer
 *   code never reads it when `data-cite` is there; it is written so a copy of
 *   Corpus from before ids existed — the other laptop, a backup — still finds
 *   its footnote rather than discarding the span.
 * - `contenteditable="false"` makes it one character as far as the caret is
 *   concerned. The sanitiser used to strip it, so every reopened draft had
 *   markers you could type into — and the export drops whatever is inside a
 *   marker, so the words typed there vanished from the Word file.
 *
 * A marker whose reference is not in the draft keeps its id and reads `[?]`.
 * Markers are only ever removed by removing their reference on purpose; a
 * marker that quietly disappears is a footnote lost without anyone noticing.
 *
 * Pure string functions, safe on the server and in the browser.
 */

export interface MarkerRef {
  id: number;
}

/** The label for a marker: "[3]", or "[?]" when its reference is missing. */
export function markerLabel(n: number | null): string {
  return n === null ? "[?]" : `[${n}]`;
}

/** A marker in canonical form. The label is redrawn by `normalizeMarkers`. */
export function markerHtml(id: number, n: number | null = null, note: number | null = null): string {
  const legacy = note === null ? "" : ` data-note="${note}"`;
  return `<span data-cite="${id}"${legacy} contenteditable="false">${markerLabel(n)}</span>`;
}

/**
 * A marker span, with no markup inside it. The lookahead keeps it to spans
 * that are markers: Chrome wraps runs of text in styled spans of its own when
 * paragraphs are merged, and one of those around a marker must not be read
 * as the marker.
 */
const MARKER_RE = /<span\b(?=[^>]*\bdata-(?:cite|note)\s*=)([^>]*)>([^<]*)<\/span>/gi;
const LABEL_RE = /\[(?:\d+|\?)\]/;

function attrNum(attrs: string, name: string): number | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*"(\\d{1,12})"`, "i").exec(attrs);
  return m ? Number(m[1]) : null;
}

/** The reference ids cited in the text, in the order they are first cited. */
export function citeOrder(html: string): number[] {
  const seen = new Set<number>();
  for (const m of html.matchAll(/\bdata-cite\s*=\s*"(\d{1,12})"/gi)) seen.add(Number(m[1]));
  return [...seen];
}

/**
 * The number each reference shows: its place among the references actually
 * cited, by first appearance. References not cited anywhere have none.
 */
export function numbering(html: string, refs: MarkerRef[]): Map<number, number> {
  const known = new Set(refs.map((r) => r.id));
  const out = new Map<number, number>();
  for (const id of citeOrder(html)) if (known.has(id)) out.set(id, out.size + 1);
  return out;
}

/**
 * Every marker in canonical form, numbered by first appearance.
 *
 * `refs` is the draft's reference list in stored order. A marker from before
 * ids were recorded (`data-note` alone) is given the id at that index, which
 * is what the desk has always shown for it; one past the end of the list has
 * nothing to point at and is dropped, as it always was. Text that ended up
 * inside a marker — typed there while it was editable — is put back after it
 * rather than lost.
 */
export function normalizeMarkers(html: string, refs: MarkerRef[]): string {
  if (!html) return html;
  const known = new Set(refs.map((r) => r.id));
  const seqIndex = new Map(refs.map((r, i) => [r.id, i]));
  const numbers = new Map<number, number>();

  return html.replace(MARKER_RE, (_whole, attrs: string, inner: string) => {
    let id = attrNum(attrs, "data-cite");
    if (id === null) {
      const legacy = attrNum(attrs, "data-note");
      const ref = legacy === null ? undefined : refs[legacy];
      if (!ref) return inner.replace(LABEL_RE, "");
      id = ref.id;
    }
    let n: number | null = null;
    if (known.has(id)) {
      if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
      n = numbers.get(id)!;
    }
    const stray = inner.replace(LABEL_RE, "");
    return markerHtml(id, n, seqIndex.get(id) ?? null) + stray;
  });
}

/** Points every marker for one reference at another. */
export function retargetMarkers(html: string, from: number, to: number): string {
  return html.replace(new RegExp(`(\\bdata-cite\\s*=\\s*")${from}(")`, "g"), `$1${to}$2`);
}

/** Takes out the markers for a reference that is being removed. */
export function stripMarkers(html: string, id: number): string {
  return html.replace(MARKER_RE, (whole, attrs: string, inner: string) =>
    attrNum(attrs, "data-cite") === id ? inner.replace(LABEL_RE, "") : whole
  );
}

/**
 * Bracketed numbers in the text that are not markers — a citation flattened
 * to plain characters somewhere along the way. They look like citations on
 * screen and export as literal text, so the desk points them out.
 */
export function strayBrackets(html: string): string[] {
  const text = html.replace(MARKER_RE, "").replace(/<[^>]*>/g, " ");
  return text.match(/\[\d{1,3}\]/g) ?? [];
}
