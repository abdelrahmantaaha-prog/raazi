"use client";

import { Fragment, type ReactNode } from "react";
import { normaliseMarkers } from "@/lib/markers";

export interface Citation {
  id: number;
  quote: string;
  citation: string;
  sourceId: number;
  sourceTitle: string;
  locator: string;
  /**
   * You rejected this passage, and the entry has not been rewritten yet. The
   * marker stays, struck through, rather than disappearing — see EntryBody.
   */
  discarded?: boolean;
}

/**
 * Renders an entry body: light Markdown, plus the thing that matters — every
 * [[m:ID]] marker becomes a numbered, hoverable citation resolving to the exact
 * quote it came from. A marker with no matching evidence is dropped rather than
 * shown, because a citation you cannot check is worse than none.
 *
 * Evidence you discarded by hand is the one exception, and it is the reverse
 * case. Dropping those markers too would take a sentence whose support you had
 * just rejected and render it as clean, confident, uncited prose — the entry
 * would look *better* for having lost its evidence, which is precisely backwards
 * in a tool whose promise is that every claim is checkable. So the marker stays,
 * struck through, until the entry is rewritten without the sentence.
 */
export function EntryBody({
  body,
  citations,
  dir = "ltr",
  onCite,
  activeId,
  renderText,
}: {
  body: string;
  citations: Map<number, Citation>;
  dir?: "ltr" | "rtl";
  /**
   * Called with the mention id and the marker that was clicked — the element is
   * what lets the quote open beside the sentence it supports rather than at the
   * foot of the page, where checking a citation meant losing your place.
   */
  onCite: (id: number, anchor: HTMLElement) => void;
  activeId?: number;
  /**
   * Wraps the plain-prose runs between citation markers.
   *
   * The hook exists so entity names in the text can become links without this
   * component knowing what an entity is. It receives only the text nodes — a
   * name that happens to sit inside a [[m:ID]] marker is never handed over, so
   * linking cannot corrupt a citation.
   */
  renderText?: (text: string, key: number) => ReactNode;
}) {
  const order = citationOrder(body, citations);

  return (
    <div className="prose-entry" dir={dir}>
      {blocks(body).map((block, i) => (
        <Block
          key={i}
          block={block}
          citations={citations}
          order={order}
          onCite={onCite}
          activeId={activeId}
          renderText={renderText}
        />
      ))}
    </div>
  );
}

/**
 * Citation numbers, in the order they first appear in the prose.
 *
 * Shared so the marker, the popover and the reference list underneath all agree
 * on which quote is number four — they used to number independently, and the
 * list was in whatever order the evidence happened to be stored.
 */
export function citationOrder(
  body: string,
  citations: Map<number, Citation>
): Map<number, number> {
  const order = new Map<number, number>();
  for (const m of normaliseMarkers(body).matchAll(/\[\[m:(\d+)\]\]/g)) {
    const id = Number(m[1]);
    if (citations.has(id) && !order.has(id)) order.set(id, order.size + 1);
  }
  return order;
}

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

function Block({
  block,
  citations,
  order,
  onCite,
  activeId,
  renderText,
}: {
  block: BlockNode;
  citations: Map<number, Citation>;
  order: Map<number, number>;
  onCite: (id: number, anchor: HTMLElement) => void;
  activeId?: number;
  renderText?: (text: string, key: number) => ReactNode;
}) {
  const inline = (t: string) => (
    <Inline
      text={t}
      citations={citations}
      order={order}
      onCite={onCite}
      activeId={activeId}
      renderText={renderText}
    />
  );

  switch (block.kind) {
    case "h": {
      const Tag = (["h1", "h2", "h3", "h4"] as const)[Math.min(block.level, 4) - 1];
      return <Tag>{inline(block.text)}</Tag>;
    }
    case "quote":
      return <blockquote>{inline(block.text)}</blockquote>;
    case "ul":
      return (
        <ul>
          {block.items.map((t, i) => (
            <li key={i}>{inline(t)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol>
          {block.items.map((t, i) => (
            <li key={i}>{inline(t)}</li>
          ))}
        </ol>
      );
    default:
      return <p>{inline(block.text)}</p>;
  }
}

function Inline({
  text,
  citations,
  order,
  onCite,
  activeId,
  renderText,
}: {
  text: string;
  citations: Map<number, Citation>;
  order: Map<number, number>;
  onCite: (id: number, anchor: HTMLElement) => void;
  activeId?: number;
  renderText?: (text: string, key: number) => ReactNode;
}) {
  // Citations first, so emphasis inside a marker can't corrupt it.
  const parts = text.split(/(\[\[m:\d+\]\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\[\[m:(\d+)\]\]$/.exec(part);
        if (!m) {
          return (
            <Fragment key={i}>{renderText ? renderText(part, i) : emphasis(part)}</Fragment>
          );
        }

        const id = Number(m[1]);
        const cite = citations.get(id);
        if (!cite) return null;

        const active = activeId === id;
        return (
          <button
            key={i}
            type="button"
            onClick={(e) => onCite(id, e.currentTarget)}
            title={
              cite.discarded
                ? `You discarded this evidence. The sentence still rests on it until the entry is rewritten. — ${cite.citation}`
                : `${cite.citation} — click to see the quote`
            }
            aria-label={
              cite.discarded
                ? `Discarded citation ${order.get(id) ?? ""}: ${cite.citation}`
                : `Citation ${order.get(id) ?? ""}: ${cite.citation}`
            }
            className={`mx-0.5 cursor-pointer rounded px-1 align-super text-[0.65em] font-sans font-semibold transition ${
              cite.discarded
                ? "bg-red-100 text-red-700 line-through hover:bg-red-200"
                : active
                  ? "bg-[var(--color-accent)] text-white"
                  : "bg-[var(--color-accent-soft)] text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-white"
            }`}
          >
            {order.get(id) ?? "•"}
          </button>
        );
      })}
    </>
  );
}

/** Bold, italic, and inline code. Deliberately small. */
function emphasis(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("**")) nodes.push(<strong key={m.index}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`"))
      nodes.push(
        <code key={m.index} className="rounded bg-neutral-100 px-1 text-[0.9em]">
          {token.slice(1, -1)}
        </code>
      );
    else nodes.push(<em key={m.index}>{token.slice(1, -1)}</em>);
    last = m.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
