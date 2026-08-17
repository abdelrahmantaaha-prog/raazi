"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { EntryBody, type Citation } from "./EntryBody";
import { dirOf } from "@/lib/dir";
import { linkEntities, type LinkTarget } from "@/lib/entity-links";

/**
 * An entry, opened beside whatever you were doing.
 *
 * A sheet rather than a modal, and anchored to the side rather than the middle,
 * for a reason that only shows up in use: the two places this opens from are a
 * book you are reading and an entry you are reading, and in both the thing
 * underneath is text you want to keep looking at. A centred popup covers exactly
 * that. On a phone there is no beside, so it becomes a bottom sheet — the
 * gesture is the same and the reading position is still held.
 *
 * It keeps a stack. Following a name inside an entry pushes rather than
 * replaces, so three entries deep you can still get back to where you started,
 * which is the ordinary way research actually goes.
 *
 * Portalled to the body because the reader itself is a portalled full-screen
 * panel: nested inside it, this would be trapped in its stacking context and
 * paint underneath. That is the same trap the navigation rail fell into.
 */

interface Brief {
  entity: {
    id: number;
    type: string;
    canonical_name: string;
    disambiguator: string | null;
    entry_state: string;
  };
  entry: { summary: string; body_md: string; updated_at: string } | null;
  citations: Citation[];
  evidenceCount: number;
  links: LinkTarget[];
}

export function EntityDrawer({
  entityId,
  onClose,
}: {
  entityId: number | null;
  onClose: () => void;
}) {
  /** Where we have been, so "back" means something. */
  const [stack, setStack] = useState<number[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(false);
  const [openQuote, setOpenQuote] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  // A new subject from outside resets the trail; following a name inside the
  // panel does not.
  useEffect(() => {
    setStack(entityId === null ? [] : [entityId]);
  }, [entityId]);

  const current = stack[stack.length - 1] ?? null;

  useEffect(() => {
    if (current === null) {
      setBrief(null);
      return;
    }
    let live = true;
    setLoading(true);
    setOpenQuote(null);
    void fetch(`/api/entities/${current}/brief`)
      .then((r) => r.json())
      .then((d: Brief) => {
        if (live) setBrief(d.entity ? d : null);
      })
      .catch(() => live && setBrief(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [current]);

  const back = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  // Escape steps back through the trail before it closes, which is what the
  // key means everywhere else: undo the last thing, not all of it.
  useEffect(() => {
    if (current === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (stack.length > 1) back();
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [current, stack.length, back, onClose]);

  // Scroll back to the top when the subject changes: three entries deep, the
  // panel was opening halfway down the new entry because it kept the old one's
  // scroll position.
  useEffect(() => {
    panel.current?.scrollTo({ top: 0 });
  }, [current]);

  if (!mounted || current === null) return null;

  const citations = new Map((brief?.citations ?? []).map((c) => [c.id, c]));
  const quote = openQuote === null ? null : citations.get(openQuote);
  const dir = dirOf(brief?.entry?.body_md ?? brief?.entity.canonical_name ?? "");

  return createPortal(
    <>
      {/* The book stays visible and stays put; the scrim only catches clicks. */}
      <div
        onClick={onClose}
        className="fixed inset-0 z-50 bg-black/20 transition-opacity"
        aria-hidden
      />

      <aside
        role="dialog"
        aria-label={brief?.entity.canonical_name ?? "Entry"}
        className="fixed inset-x-0 bottom-0 z-50 flex max-h-[78vh] flex-col rounded-t-xl border border-[var(--color-rule)] bg-[var(--color-paper)] shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[min(30rem,92vw)] sm:rounded-none sm:border-y-0 sm:border-r-0"
      >
        <header className="flex items-start gap-2 border-b border-[var(--color-rule)] px-4 py-3">
          {stack.length > 1 && (
            <button
              onClick={back}
              className="mt-0.5 shrink-0 text-sm text-[var(--color-muted)] hover:text-[var(--color-accent)]"
              aria-label="Back"
            >
              ←
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-serif text-lg font-semibold">
              {brief?.entity.canonical_name ?? (loading ? "…" : "Not found")}
            </h2>
            {brief?.entity.disambiguator && (
              <p className="truncate text-xs text-[var(--color-muted)]">
                {brief.entity.disambiguator}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-lg leading-none text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div ref={panel} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {loading && !brief && <p className="text-sm text-[var(--color-muted)]">Opening…</p>}

          {brief && !brief.entry && (
            <p className="text-sm text-[var(--color-muted)]">
              No entry has been written for {brief.entity.canonical_name} yet
              {brief.evidenceCount > 0
                ? ` — ${brief.evidenceCount} passage${brief.evidenceCount === 1 ? "" : "s"} are on record.`
                : "."}
            </p>
          )}

          {brief?.entry && (
            <>
              {brief.entry.summary && (
                <p className="mb-3 text-sm text-[var(--color-muted)]" dir={dir}>
                  {brief.entry.summary}
                </p>
              )}
              <div className="text-[0.95rem]">
                <EntryBody
                  body={brief.entry.body_md}
                  citations={citations}
                  dir={dir}
                  onCite={(id) => setOpenQuote((prev) => (prev === id ? null : id))}
                  activeId={openQuote ?? undefined}
                  renderText={(text, key) => (
                    <NameLinks
                      key={key}
                      text={text}
                      links={brief.links}
                      onFollow={(id) => setStack((s) => [...s, id])}
                    />
                  )}
                />
              </div>
            </>
          )}

          {quote && (
            <div className="mt-4 rounded-lg border border-[var(--color-rule)] bg-white p-3">
              <p className="text-xs font-medium text-[var(--color-accent)]">{quote.citation}</p>
              <blockquote
                className="mt-1 text-sm italic"
                dir={dirOf(quote.quote)}
              >
                “{quote.quote}”
              </blockquote>
            </div>
          )}
        </div>

        <footer className="border-t border-[var(--color-rule)] px-4 py-2.5">
          <Link
            href={`/pedia/${current}`}
            className="text-sm text-[var(--color-accent)] hover:underline"
          >
            Open the full entry →
          </Link>
        </footer>
      </aside>
    </>,
    document.body
  );
}

function NameLinks({
  text,
  links,
  onFollow,
}: {
  text: string;
  links: LinkTarget[];
  onFollow: (id: number) => void;
}) {
  const spans = linkEntities(text, links);
  return (
    <>
      {spans.map((s, i) =>
        s.entityId === undefined ? (
          <span key={i}>{s.text}</span>
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => onFollow(s.entityId!)}
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
