import { normaliseMarkers } from "./markers";

/**
 * The light Markdown an entry or a brief is written in, split into blocks.
 *
 * Moved out of the EntryBody component so the server can read a body the same
 * way the page draws it: the brief's Expand button names a heading, and the
 * section the server gathers for it has to be exactly the section on screen.
 * Pure string functions with no dependencies beyond the marker grammar, so the
 * client renderer and server code can both import them.
 */

export type BlockNode =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

/**
 * Models do not always put blank lines around their headings, and occasionally
 * emit a whole entry as one line with `###` markers buried in the prose. Two
 * repairs, in order of how much can be recovered:
 *
 *  - a heading on its own line separated by a single newline is unambiguous, so
 *    it is promoted to a real block;
 *  - a marker buried mid-sentence is not: where the heading ends and the prose
 *    begins cannot be told apart reliably ("### Early Life and Character Prince
 *    Feisal was…" could break after "Character" or after "Feisal"). Guessing
 *    would split a sentence in half, so the marker is simply dropped and a
 *    paragraph break inserted. Nothing is lost and nothing reads as broken.
 */
export function normalise(md: string): string {
  return (
    normaliseMarkers(md)
      .replace(/\r\n/g, "\n")
      // A heading following a single newline gets the blank line it needed.
      .replace(/([^\n])\n(#{1,6}[ \t])/g, "$1\n\n$2")
      // A marker sitting mid-line after a finished sentence. Requiring the
      // sentence-ending punctuation keeps this away from a stray "30# in 1961",
      // and matching the whole run keeps it out of the middle of a "##".
      .replace(/([.!?:;)\]”"'][ \t]+)#{1,6}[ \t]+/g, "$1\n\n")
  );
}

/** Beyond this a "heading" is a paragraph that happens to start with a marker. */
const MAX_HEADING = 90;

export function blocks(md: string): BlockNode[] {
  const out: BlockNode[] = [];
  const chunks = normalise(md).split(/\n{2,}/);

  for (const raw of chunks) {
    const text = raw.trim();
    if (!text) continue;

    // A heading may lead a block that also carries its first paragraph.
    const leading = /^(#{1,6})[ \t]+([^\n]*)(?:\n([\s\S]*))?$/.exec(text);
    if (leading) {
      const label = leading[2].trim();
      const rest = leading[3]?.trim();

      // A "heading" the length of a paragraph is a paragraph whose marker was
      // never closed by a line break. Render the prose, drop the marker.
      if (label.length > MAX_HEADING) {
        out.push({ kind: "p", text: [label, rest].filter(Boolean).join(" ") });
        continue;
      }

      out.push({ kind: "h", level: Math.min(leading[1].length, 4), text: label });
      if (rest) out.push(...blocks(rest));
      continue;
    }

    const lines = text.split("\n");
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
      out.push({ kind: "ul", items: lines.map((l) => l.replace(/^\s*[-*•]\s+/, "")) });
      continue;
    }
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      out.push({ kind: "ol", items: lines.map((l) => l.replace(/^\s*\d+[.)]\s+/, "")) });
      continue;
    }
    if (lines.every((l) => /^\s*>/.test(l))) {
      out.push({ kind: "quote", text: lines.map((l) => l.replace(/^\s*>\s?/, "")).join(" ") });
      continue;
    }
    out.push({ kind: "p", text: lines.join(" ") });
  }
  return out;
}
