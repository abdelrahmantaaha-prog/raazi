"use client";

import { linkEntities, type LinkTarget } from "@/lib/entity-links";

/**
 * Names in the prose that the library knows, made openable.
 *
 * They open beside the entry rather than replacing it: following a reference
 * three deep and wanting the original back is the normal shape of reading an
 * encyclopedia, and browser history is a poor substitute for it.
 *
 * One component for the entry page and the drawer. It was written twice, and
 * the two copies had already started to drift.
 */
export function NameLinks({
  text,
  links,
  onOpen,
}: {
  text: string;
  links: LinkTarget[];
  onOpen: (id: number) => void;
}) {
  return (
    <>
      {linkEntities(text, links).map((s, i) =>
        s.entityId === undefined ? (
          <span key={i}>{s.text}</span>
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => onOpen(s.entityId!)}
            title={`Open ${s.entityName}`}
            className="cursor-pointer border-b border-dotted border-[var(--color-accent)] text-inherit hover:bg-[var(--color-accent-soft)]"
          >
            {s.text}
          </button>
        )
      )}
    </>
  );
}
