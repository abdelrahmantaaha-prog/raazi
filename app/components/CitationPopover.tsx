"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { dirOf } from "@/lib/dir";
import type { Citation } from "./EntryBody";

const WIDTH = 380;
const MARGIN = 12;
/** Enough room below the marker to be worth opening downward. */
const NEEDED = 200;

/**
 * The quote behind a citation, opened next to the citation.
 *
 * It used to render as a card underneath the whole entry, which meant checking
 * a source cost you your place in the paragraph — the opposite of what a
 * footnote is for. Anchoring it to the marker keeps the sentence and the
 * evidence in one glance.
 *
 * Position is recomputed on scroll and resize rather than frozen, so the quote
 * stays pinned to its marker while you read around it.
 */
export function CitationPopover({
  citation,
  anchor,
  index,
  onClose,
  onShowInEvidence,
}: {
  citation?: Citation;
  anchor: HTMLElement | null;
  index?: number;
  onClose: () => void;
  onShowInEvidence: (id: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null);
  // Held in a ref so the positioning effect does not re-run — and tear down its
  // scroll listener — every time the parent hands down a fresh callback.
  const closer = useRef(onClose);
  closer.current = onClose;

  const id = citation?.id;

  useLayoutEffect(() => {
    if (!anchor || id === undefined) {
      setPos(null);
      return;
    }

    const place = () => {
      const r = anchor.getBoundingClientRect();
      // The marker can scroll out from under a tall quote; when it does the
      // popover has nothing to point at, so it closes rather than float free.
      if (r.bottom < 0 || r.top > window.innerHeight) return closer.current();

      const height = box.current?.offsetHeight ?? NEEDED;
      const above = r.bottom + NEEDED > window.innerHeight && r.top > NEEDED;
      const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2);
      const next = {
        top: above ? r.top - height - 8 : r.bottom + 8,
        // Centred on the marker, then pushed back inside the window.
        left: Math.min(
          Math.max(r.left + r.width / 2 - width / 2, MARGIN),
          window.innerWidth - width - MARGIN
        ),
        above,
      };

      // Bail on an unchanged position. Without this the state update re-runs
      // this very effect, which places again, which updates state — the
      // popover ends up pinned wherever the first pass put it and stops
      // tracking its marker entirely.
      setPos((cur) =>
        cur && cur.top === next.top && cur.left === next.left && cur.above === next.above
          ? cur
          : next
      );
    };

    place();
    // A second pass once the box has a real height, so a long quote opening
    // upward is not left overlapping its own marker.
    const raf = requestAnimationFrame(place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, id]);

  useEffect(() => {
    if (id === undefined) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && closer.current();
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor?.contains(t)) closer.current();
    };
    document.addEventListener("keydown", key);
    // Deferred: the click that opened this must not immediately close it.
    const armed = setTimeout(() => document.addEventListener("mousedown", away), 0);
    return () => {
      clearTimeout(armed);
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", away);
    };
  }, [id, anchor]);

  if (!citation) return null;

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={`Source for citation ${index ?? ""}`}
      className="fade-in fixed z-50 rounded-lg border border-[var(--color-accent)] bg-white p-3 shadow-xl"
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: Math.min(WIDTH, typeof window === "undefined" ? WIDTH : window.innerWidth - 24),
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium leading-snug">
          {index !== undefined && (
            <span className="mr-1.5 text-[var(--color-accent)]">{index}.</span>
          )}
          {citation.citation}
        </p>
        <button
          onClick={onClose}
          className="-mt-1 shrink-0 text-lg leading-none text-[var(--color-muted)] hover:text-[var(--color-ink)]"
          aria-label="Close citation"
        >
          ×
        </button>
      </div>

      <blockquote
        className="mt-2 max-h-56 overflow-y-auto border-l-2 border-[var(--color-accent)] pl-3 text-sm italic"
        dir={dirOf(citation.quote)}
      >
        “{citation.quote}”
      </blockquote>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button
          onClick={() => onShowInEvidence(citation.id)}
          className="rounded bg-[var(--color-accent)] px-2.5 py-1 font-medium text-white"
        >
          Show in evidence
        </button>
        <Link
          href={`/sources/${citation.sourceId}${citation.id ? `#m${citation.id}` : ""}`}
          className="rounded border border-[var(--color-rule)] px-2.5 py-1 font-medium hover:bg-[var(--color-accent-soft)]"
        >
          Read in {citation.sourceTitle}
          {citation.locator ? ` — ${citation.locator}` : ""}
        </Link>
      </div>
    </div>
  );
}
