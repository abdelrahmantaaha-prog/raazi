"use client";

import { memo } from "react";
import { dirOf } from "@/lib/dir";

export interface MentionRef {
  surface: string;
  entityId: number;
  name: string;
}

/**
 * One paragraph of the book.
 *
 * Split out and memoised because the reader re-rendered every paragraph of a
 * six-hundred-page book — and re-ran the entity highlighting regex on each —
 * every time the cursor moved one paragraph on, the voice advanced, or a
 * bookmark was toggled. Everything a paragraph needs is passed as a plain
 * value, so a paragraph whose text, lit state and highlights are unchanged
 * is not touched.
 *
 * `mentions` is the block's array, which the reader builds once per source;
 * `onOpen` is a state setter, stable for the life of the component.
 */
export const ReaderParagraph = memo(function ReaderParagraph({
  text,
  at,
  lit,
  speaking,
  indent,
  highlights,
  mentions,
  mark,
  ink,
  onOpen,
}: {
  text: string;
  /** Its position in the whole book, which is what reading mode counts in. */
  at: number;
  lit: boolean;
  /** The voice is on this one. */
  speaking: boolean;
  indent: boolean;
  highlights: boolean;
  mentions: MentionRef[];
  /** The highlight colour of the current theme. */
  mark: string;
  /** The ink colour of the current theme, for the speaking rule. */
  ink: string;
  onOpen: (entityId: number) => void;
}) {
  return (
    <p
      data-para={at}
      className="relative mb-[0.9em]"
      dir={dirOf(text)}
      style={{
        textIndent: indent ? "1.4em" : undefined,
        // Dimmed rather than hidden: the shape of the page stays put, so the
        // paragraph you are on does not jump around as you advance, and you
        // can still see roughly where you are.
        opacity: lit ? 1 : 0.13,
        transition: "opacity 260ms ease",
      }}
    >
      {/*
       * Which paragraph the voice is on.
       *
       * A rule in the margin rather than a wash over the text: the page is
       * already carrying entity highlights in this colour, and tinting a
       * whole paragraph on top of them turned the thing you were listening
       * to into the busiest block on the page. Sitting in the gutter, it is
       * absolutely positioned and so cannot reflow a word — the alternative,
       * a border on the text edge, would have nudged the measure inward every
       * time the voice moved on.
       */}
      {speaking && (
        <span
          aria-hidden
          className="absolute select-none"
          style={{
            // Follows the script: the start of the line is the left in
            // English and the right in Arabic, and this book can be either.
            // Inside the article's own gutter, so it is never clipped on a
            // narrow screen.
            insetInlineStart: "-0.85em",
            top: "0.2em",
            bottom: "0.2em",
            width: "2px",
            borderRadius: "1px",
            background: ink,
            opacity: 0.5,
          }}
        />
      )}
      {highlights ? highlight(text, mentions, mark, onOpen) : text}
    </p>
  );
});

function highlight(
  text: string,
  mentions: MentionRef[],
  mark: string,
  onOpen: (entityId: number) => void
) {
  const unique = new Map<string, MentionRef>();
  for (const m of mentions) if (m.surface.trim().length > 2) unique.set(m.surface, m);
  const surfaces = [...unique.keys()].sort((a, b) => b.length - a.length);
  if (!surfaces.length) return text;

  const re = new RegExp(
    `(${surfaces.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "g"
  );

  return text.split(re).map((part, i) => {
    const hit = unique.get(part);
    if (!hit) return part;
    // Opens beside the book rather than replacing it. Following a name used to
    // navigate to /pedia, which meant leaving the page you were reading and
    // finding your way back to the sentence you were on.
    return (
      <button
        key={i}
        type="button"
        onClick={(e) => {
          e.preventDefault();
          onOpen(hit.entityId);
        }}
        title={`Open ${hit.name}`}
        className="cursor-pointer rounded-sm text-inherit"
        style={{ background: mark, boxShadow: `0 0 0 2px ${mark}`, color: "inherit" }}
      >
        {part}
      </button>
    );
  });
}
