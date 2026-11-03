/**
 * Review mode: reading a draft over a paragraph at a time and passing each.
 *
 * Nothing here writes into the draft. A paragraph is remembered as reviewed
 * by a fingerprint of its words, kept beside the draft (`reviewed_json`), and
 * shown with a stylesheet drawn from those fingerprints — so a review cannot
 * reach the saved markup, the clipboard or the Word export, and the browser's
 * own paragraphs need no class hung on them.
 *
 * The fingerprint is of what the paragraph says. Change a word and it is no
 * longer the paragraph you passed, so it comes off the list by itself.
 * Citation markers count by the reference they point at, not the number they
 * show: citing something earlier in the piece renumbers every marker after
 * it, and that is not a change to those paragraphs.
 */

export interface ReviewUnit {
  el: HTMLElement;
  /** Selects this unit, and only it, under `scope`. */
  selector: string;
  key: string;
  /** A list item, which sits further in than the paragraphs around it. */
  item: boolean;
}

/**
 * What a review steps through, in order: every block in the draft with words
 * in it, and each item of a list rather than the list as a whole.
 */
export function reviewUnits(box: HTMLElement, scope: string): ReviewUnit[] {
  const out: ReviewUnit[] = [];
  Array.from(box.children).forEach((child, i) => {
    if (!(child instanceof HTMLElement)) return;
    const at = `${scope} > :nth-child(${i + 1})`;
    if (child.tagName === "UL" || child.tagName === "OL") {
      Array.from(child.children).forEach((li, j) => {
        if (li instanceof HTMLElement && li.tagName === "LI") add(li, `${at} > :nth-child(${j + 1})`, true);
      });
    } else add(child, at, false);
  });
  return out;

  function add(el: HTMLElement, selector: string, item: boolean) {
    const text = unitText(el);
    if (text) out.push({ el, selector, key: fingerprint(text), item });
  }
}

/** The unit a node of the draft stands in, if any. */
export function unitOf(box: HTMLElement, node: Node | null): HTMLElement | null {
  let el: Node | null = node;
  while (el && el.parentNode !== box) el = el.parentNode;
  if (!(el instanceof HTMLElement)) return null;
  if (el.tagName !== "UL" && el.tagName !== "OL") return el;
  let li: Node | null = node;
  while (li && li.parentNode !== el) li = li.parentNode;
  return li instanceof HTMLElement ? li : null;
}

/** A unit's words, with each citation marker reduced to the reference it cites. */
function unitText(el: HTMLElement): string {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[data-cite], [data-note]").forEach((m) => {
    m.textContent = ` [#${m.getAttribute("data-cite") ?? `n${m.getAttribute("data-note")}`}] `;
  });
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** A 53-bit hash of the words, in base 36 — short, and stable across sessions. */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The stylesheet that shows a review: the first line of every reviewed unit
 * highlighted, and a bar beside the one you are on.
 */
export function reviewSheet(units: ReviewUnit[], reviewed: Set<string>, current: HTMLElement | null): string {
  const rules: string[] = [];
  const marked = units.filter((u) => reviewed.has(u.key)).map((u) => `${u.selector}::first-line`);
  if (marked.length) {
    rules.push(`${marked.join(",\n")} { background-color: var(--color-reviewed); }`);
  }
  const here = units.find((u) => u.el === current);
  if (here) {
    rules.push(
      `${here.selector} { position: relative; }`,
      // List items sit in by the list's indent, so their bar comes out by it.
      `${here.selector}::before { content: ""; position: absolute; inset-inline-start: ${
        here.item ? "calc(-1.5em - 0.9rem)" : "-0.9rem"
      }; top: 0.25em; bottom: 0.25em; width: 3px; border-radius: 2px; background: var(--color-accent); }`
    );
  }
  return rules.join("\n");
}
