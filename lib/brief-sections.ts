import { blocks, type BlockNode } from "./md-blocks";
import { citedIds } from "./markers";

/**
 * A written brief, read as sections.
 *
 * The Expand button on a brief heading names the heading, and everything the
 * expansion is built from is found by reading that heading's section: the
 * passages cited under it, subsections included. Pure, and built on the same
 * block grammar the page draws with, so the section the server gathers is the
 * one the reader was looking at.
 */

export interface BriefSection {
  /** The heading's text with emphasis and markers taken out — the key a section is found by. */
  heading: string;
  level: number;
  /** The mention ids cited anywhere in the section, in order of first citation. */
  mentionIds: number[];
  /** The section's own text, as Markdown, for orientation. */
  text: string;
}

/** The form a heading is matched and stored under. */
export function headingKey(text: string): string {
  return text
    .replace(/\[\[m:\d+\]\]/g, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function asText(b: BlockNode): string {
  switch (b.kind) {
    case "h":
      return `${"#".repeat(b.level)} ${b.text}`;
    case "ul":
      return b.items.map((i) => `- ${i}`).join("\n");
    case "ol":
      return b.items.map((i, n) => `${n + 1}. ${i}`).join("\n");
    case "quote":
      return `> ${b.text}`;
    default:
      return b.text;
  }
}

/** Every heading in a body, each with the section it opens. */
export function briefSections(body: string): BriefSection[] {
  const list = blocks(body ?? "");
  const out: BriefSection[] = [];
  list.forEach((b, i) => {
    if (b.kind !== "h") return;
    const parts: string[] = [];
    for (let j = i + 1; j < list.length; j++) {
      const next = list[j];
      if (next.kind === "h" && next.level <= b.level) break;
      parts.push(asText(next));
    }
    const text = parts.join("\n\n");
    out.push({ heading: headingKey(b.text), level: b.level, mentionIds: [...citedIds(text)], text });
  });
  return out;
}
