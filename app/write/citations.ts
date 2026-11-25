/**
 * Citation markers in the live editor, and on the clipboard.
 *
 * The grammar itself — what a marker is, how it is numbered — is in
 * lib/cite-markers.ts, shared with the server and the Word export. This file
 * applies it to the DOM, where the caret has to survive it, and carries
 * markers across copy and paste.
 */
import { markerLabel } from "@/lib/cite-markers";

export { markerHtml, normalizeMarkers, numbering, strayBrackets } from "@/lib/cite-markers";

export interface CitedRef {
  id: number;
}

/** What a reference needs to be recreated in another draft. */
export interface PortableRef {
  id: number;
  origin: "library" | "outside";
  text: string;
  author: string | null;
  title: string | null;
  year: string | null;
  locator: string | null;
  outlet: string | null;
  url: string | null;
  quote?: string | null;
  source_id?: number | null;
}

/**
 * What may come back in through a paste from this editor.
 *
 * Everything the editor can produce is kept and nothing else is: no styles,
 * no classes, no colours, and a span only when it is a marker.
 */
const ALLOWED = new Set(["p", "h1", "h2", "h3", "blockquote", "ul", "ol", "li", "b", "strong", "i", "em", "br"]);

export function sanitizeDraftHtml(html: string): string {
  let out = "";
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  /** Whether each open span is a marker we emitted, so its closer is paired. */
  const spans: boolean[] = [];
  while ((m = re.exec(html))) {
    out += html.slice(last, m.index);
    last = m.index + m[0].length;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3] ?? "";

    if (tag === "span") {
      if (closing) {
        if (spans.pop()) out += "</span>";
        continue;
      }
      // Kept only when it is a marker, and re-emitted in canonical form so
      // nothing of where it has been travels with it. Its label is redrawn
      // as soon as it is in the draft.
      const cite = /data-cite="(\d{1,12})"/.exec(attrs);
      if (cite) out += `<span data-cite="${cite[1]}" contenteditable="false">`;
      spans.push(Boolean(cite));
      continue;
    }

    if (ALLOWED.has(tag)) out += closing ? `</${tag}>` : `<${tag}>`;
    // Anything else: the tag goes, the words it wrapped stay.
  }
  out += html.slice(last);
  return out;
}

/**
 * Brings every marker in the live editor into canonical form, in place.
 *
 * Mutating the spans rather than rewriting `innerHTML` is what keeps the
 * caret where it was. Returns true when anything changed, so the caller knows
 * to emit the new HTML. `refs` is the reference list in stored order.
 */
export function renumberDom(root: HTMLElement, refs: CitedRef[]): boolean {
  const known = new Set(refs.map((r) => r.id));
  const seqIndex = new Map(refs.map((r, i) => [r.id, i]));
  const numbers = new Map<number, number>();
  let changed = false;

  for (const span of Array.from(root.querySelectorAll<HTMLElement>("span[data-cite], span[data-note]"))) {
    let id = span.dataset.cite ? Number(span.dataset.cite) : NaN;
    if (!Number.isFinite(id)) {
      // From before ids were recorded: the reference at that index today.
      const legacy = refs[Number(span.dataset.note)];
      if (!legacy) {
        span.replaceWith(document.createTextNode((span.textContent ?? "").replace(/\[(?:\d+|\?)\]/, "")));
        changed = true;
        continue;
      }
      id = legacy.id;
      span.dataset.cite = String(id);
      changed = true;
    }

    let n: number | null = null;
    if (known.has(id)) {
      if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
      n = numbers.get(id)!;
    }

    const note = seqIndex.get(id);
    if (note === undefined ? span.dataset.note !== undefined : span.dataset.note !== String(note)) {
      if (note === undefined) delete span.dataset.note;
      else span.dataset.note = String(note);
      changed = true;
    }

    const label = markerLabel(n);
    const text = span.textContent ?? "";
    if (text !== label || span.childNodes.length !== 1) {
      // Anything typed into the marker goes back out after it.
      const stray = text.replace(/\[(?:\d+|\?)\]/, "");
      if (stray) span.after(document.createTextNode(stray));
      span.textContent = label;
      changed = true;
    }
    if (span.getAttribute("contenteditable") !== "false") {
      span.setAttribute("contenteditable", "false");
      changed = true;
    }
    // Markers inserted before the styling moved to the stylesheet carried
    // their own; the stylesheet is the one place it lives now.
    if (span.hasAttribute("style")) {
      span.removeAttribute("style");
      changed = true;
    }
  }
  return changed;
}

/** Takes the markers for one reference out of the live editor. */
export function removeMarkersDom(root: HTMLElement, id: number): boolean {
  const spans = Array.from(root.querySelectorAll<HTMLElement>(`span[data-cite="${id}"]`));
  for (const s of spans) s.remove();
  return spans.length > 0;
}

// ---------------------------------------------------------------------------
// The clipboard
// ---------------------------------------------------------------------------

/**
 * Copying out of a draft writes the selection as markup, with each marker
 * carrying the reference it points at.
 *
 * The paste handler used to take the clipboard's plain text and guess whether
 * it was a move by comparing it with the last thing copied — so any paste
 * whose text differed by a space, came from another draft, or followed a
 * reload, turned every marker in it into the literal characters "[3]": no
 * longer a footnote, and after the next renumbering pointing at a different
 * source than the one it showed. Now the clipboard says what it holds.
 */
export const CLIP_ATTR = "data-corpus-draft";

export function clipboardHtml(fragment: DocumentFragment, draftId: number | null, refs: PortableRef[]): string {
  const holder = document.createElement("div");
  holder.setAttribute(CLIP_ATTR, String(draftId ?? ""));
  holder.appendChild(fragment);
  const byId = new Map(refs.map((r) => [r.id, r]));
  for (const span of Array.from(holder.querySelectorAll<HTMLElement>("span[data-cite]"))) {
    const ref = byId.get(Number(span.dataset.cite));
    if (ref) span.setAttribute("data-ref", JSON.stringify(portable(ref)));
  }
  return holder.outerHTML;
}

function portable(r: PortableRef): PortableRef {
  return {
    id: r.id,
    origin: r.origin,
    text: r.text,
    author: r.author,
    title: r.title,
    year: r.year,
    locator: r.locator,
    outlet: r.outlet,
    url: r.url,
    quote: r.quote ?? null,
    source_id: r.source_id ?? null,
  };
}

export interface DraftClip {
  /** The draft it was copied from; null when that was not recorded. */
  draftId: number | null;
  /** The copied markup, with markers still pointing at the source draft's ids. */
  root: HTMLElement;
  /** Each cited id in the clip, with the reference it pointed at when copied. */
  refs: Map<number, PortableRef | null>;
}

/** Reads a clipboard that came from a draft; null for anything else. */
export function readClip(html: string): DraftClip | null {
  if (!html.includes(CLIP_ATTR)) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.querySelector<HTMLElement>(`[${CLIP_ATTR}]`);
  if (!root) return null;
  const draft = Number(root.getAttribute(CLIP_ATTR));
  const refs = new Map<number, PortableRef | null>();
  for (const span of Array.from(root.querySelectorAll<HTMLElement>("span[data-cite]"))) {
    const id = Number(span.dataset.cite);
    if (refs.get(id)) continue;
    let ref: PortableRef | null = null;
    try {
      const parsed = JSON.parse(span.getAttribute("data-ref") ?? "null");
      if (parsed && typeof parsed === "object" && typeof parsed.text === "string") ref = parsed as PortableRef;
    } catch {
      /* a marker without its reference still pastes; it reads [?] */
    }
    refs.set(id, ref);
  }
  return { draftId: Number.isFinite(draft) && draft > 0 ? draft : null, root, refs };
}

/** Points the clip's markers at this draft's ids. */
export function retargetClip(clip: DraftClip, map: Map<number, number>): string {
  for (const span of Array.from(clip.root.querySelectorAll<HTMLElement>("span[data-cite]"))) {
    const to = map.get(Number(span.dataset.cite));
    if (to !== undefined) span.dataset.cite = String(to);
    span.removeAttribute("data-ref");
  }
  return sanitizeDraftHtml(clip.root.innerHTML);
}
