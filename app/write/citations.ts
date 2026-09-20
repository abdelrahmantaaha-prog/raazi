/**
 * Citation markers in the draft's HTML.
 *
 * A marker used to carry only a literal number and a positional index —
 * `<span data-note="2">[3]</span>` — so deleting reference 1 renumbered the
 * list while the text still said [3], and the last index pointed past the end
 * of the array the Word export reads. Now each marker carries the citation's
 * own id in `data-cite`, and both the number it shows and the `data-note`
 * index are recomputed from the current reference list whenever that changes.
 *
 * `data-note` is kept as the *current* index rather than dropped, because
 * lib/richtext.ts reads it to place footnotes and that file is the export's
 * contract with the editor.
 *
 * Pure string functions, so they can be tested without a browser; the desk
 * applies the same rules to the live DOM so the caret is never disturbed.
 */

export interface CitedRef {
  id: number;
}

const MARKER_STYLE =
  "vertical-align:super;font-size:0.72em;color:var(--color-accent);padding:0 1px;cursor:default";

/** The marker for a reference at its position in the list. */
export function citationMarker(refId: number, index: number): string {
  return (
    `<span data-cite="${refId}" data-note="${index}" contenteditable="false" ` +
    `style="${MARKER_STYLE}">[${index + 1}]</span>&nbsp;`
  );
}

/** `[3]` for the third reference. */
export function markerText(index: number): string {
  return `[${index + 1}]`;
}

const SPAN = /<span\b([^>]*)>(\[\d+\]|\[\?\])<\/span>/gi;

/**
 * Brings every marker in a stored draft up to date with the reference list.
 *
 * A marker whose reference has been removed is taken out of the text; a
 * marker from before ids were recorded (`data-note` only) is upgraded to carry
 * the id of whatever sits at that index today, which is the best that can be
 * said of it.
 */
export function renumberHtml(html: string, refs: CitedRef[]): string {
  if (!html) return html;
  return html.replace(SPAN, (whole, attrs: string) => {
    const cite = /data-cite="(\d+)"/.exec(attrs);
    const note = /data-note="(\d+)"/.exec(attrs);
    if (!cite && !note) return whole;

    let id = cite ? Number(cite[1]) : NaN;
    if (!cite && note) {
      const legacy = refs[Number(note[1])];
      if (!legacy) return "";
      id = legacy.id;
    }
    const index = refs.findIndex((r) => r.id === id);
    if (index < 0) return "";

    let next = attrs;
    next = cite
      ? next.replace(/data-cite="\d+"/, `data-cite="${id}"`)
      : ` data-cite="${id}"${next}`;
    next = note
      ? next.replace(/data-note="\d+"/, `data-note="${index}"`)
      : `${next} data-note="${index}"`;
    return `<span${next}>${markerText(index)}</span>`;
  });
}

/**
 * What may survive a move inside the draft.
 *
 * Moving a paragraph means cut and paste, and the paste handler takes the
 * clipboard's plain text — deliberately, so a paragraph dragged in from a web
 * page does not bring its fonts and colours with it. But a citation marker is
 * a span, and plain text flattens it to the four characters `[3]`: it stops
 * renumbering, stops being removed when its reference is deleted, and exports
 * as literal text rather than a footnote. Moving a paragraph quietly cost you
 * every citation in it.
 *
 * So text that came out of this editor is put back as markup, through this
 * allowlist. Everything the editor can produce is kept and nothing else is:
 * no styles, no classes, no colours, and a span only when it is a marker.
 */
const ALLOWED = new Set(["p", "h1", "h2", "h3", "blockquote", "ul", "ol", "li", "b", "strong", "i", "em", "br"]);

export function sanitizeDraftHtml(html: string): string {
  let out = "";
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out += html.slice(last, m.index);
    last = m.index + m[0].length;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3] ?? "";

    if (tag === "span") {
      // Kept only when it is a marker, and re-emitted in canonical form so
      // nothing of where it has been travels with it.
      const cite = /data-cite="(\d+)"/.exec(attrs);
      const note = /data-note="(\d+)"/.exec(attrs);
      if (!closing && cite) {
        out += `<span data-cite="${cite[1]}" data-note="${note ? note[1] : 0}" contenteditable="false" style="${MARKER_STYLE}">`;
      } else if (closing) {
        // A closing span is emitted only if we opened one; an unmatched close
        // is harmless in a fragment the browser is about to parse.
        out += "</span>";
      }
      continue;
    }

    if (ALLOWED.has(tag)) out += closing ? `</${tag}>` : `<${tag}>`;
    // Anything else: the tag goes, the words it wrapped stay.
  }
  out += html.slice(last);
  return out;
}

/**
 * The same rules applied to the live editor, in place.
 *
 * Returns true when anything changed, so the caller knows whether to emit the
 * new HTML. Mutating the spans rather than rewriting `innerHTML` is what keeps
 * the caret where it was.
 */
export function renumberDom(root: HTMLElement, refs: CitedRef[]): boolean {
  let changed = false;
  for (const span of Array.from(root.querySelectorAll<HTMLElement>("span[data-cite], span[data-note]"))) {
    const cite = span.dataset.cite;
    const note = span.dataset.note;
    let id = cite ? Number(cite) : NaN;
    if (!cite && note !== undefined) {
      const legacy = refs[Number(note)];
      if (!legacy) {
        span.remove();
        changed = true;
        continue;
      }
      id = legacy.id;
    }
    const index = refs.findIndex((r) => r.id === id);
    if (index < 0) {
      span.remove();
      changed = true;
      continue;
    }
    if (span.dataset.cite !== String(id)) {
      span.dataset.cite = String(id);
      changed = true;
    }
    if (span.dataset.note !== String(index)) {
      span.dataset.note = String(index);
      changed = true;
    }
    if (span.textContent !== markerText(index)) {
      span.textContent = markerText(index);
      changed = true;
    }
  }
  return changed;
}
