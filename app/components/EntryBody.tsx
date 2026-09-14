"use client";

import { Fragment, type ReactNode } from "react";
import { normaliseMarkers } from "@/lib/markers";
import { blocks, type BlockNode } from "@/lib/md-blocks";

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
  headingExtra,
  sectionEnd,
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
  /** Drawn inside a heading, after its text — the brief's Expand button. */
  headingExtra?: (heading: SectionHeading) => ReactNode;
  /**
   * Drawn where a heading's section closes: before the next heading at its own
   * level or above, or at the end. After its subsections, so something that
   * belongs to the whole section sits under all of it.
   */
  sectionEnd?: (heading: SectionHeading) => ReactNode;
}) {
  const order = citationOrder(body, citations);

  const out: ReactNode[] = [];
  const open: SectionHeading[] = [];
  const close = (level: number) => {
    while (open.length && open[open.length - 1].level >= level) {
      const heading = open.pop()!;
      const end = sectionEnd?.(heading);
      if (end) out.push(<Fragment key={`end-${out.length}`}>{end}</Fragment>);
    }
  };

  blocks(body).forEach((block, i) => {
    if (block.kind === "h") {
      close(block.level);
      open.push({ text: block.text, level: block.level });
    }
    out.push(
      <Block
        key={`b-${i}`}
        block={block}
        citations={citations}
        order={order}
        onCite={onCite}
        activeId={activeId}
        renderText={renderText}
        extra={block.kind === "h" ? headingExtra?.({ text: block.text, level: block.level }) : undefined}
      />
    );
  });
  close(0);

  return (
    <div className="prose-entry" dir={dir}>
      {out}
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

// The block grammar lives in lib/md-blocks.ts so the server reads a body's
// sections exactly as they are drawn here; re-exported for existing callers.
export { blocks, normalise, type BlockNode } from "@/lib/md-blocks";

/** A heading, as the section hooks receive it. */
export interface SectionHeading {
  text: string;
  level: number;
}

function Block({
  block,
  citations,
  order,
  onCite,
  activeId,
  renderText,
  extra,
}: {
  block: BlockNode;
  citations: Map<number, Citation>;
  order: Map<number, number>;
  onCite: (id: number, anchor: HTMLElement) => void;
  activeId?: number;
  renderText?: (text: string, key: number) => ReactNode;
  extra?: ReactNode;
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
      return (
        <Tag>
          {inline(block.text)}
          {extra}
        </Tag>
      );
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
