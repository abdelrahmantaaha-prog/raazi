"use client";

import { useEffect, useState } from "react";
import { Modal } from "../components/Modal";
import { dirOf } from "@/lib/dir";
// Types only — erased at compile time, so the database module stays out of the bundle.
import type { CitablePassage, CitableSource } from "@/lib/cite-search";

export type LibraryPick = { kind: "passage"; passage: CitablePassage } | { kind: "source"; source: CitableSource };

/**
 * Cite anything in the library without leaving the sentence you are writing.
 *
 * Opened from the editor's toolbar. It searches every source by its title,
 * author and outlet, and the text of all of them, and whatever you choose is
 * cited where the cursor was when you opened it — as a bare reference, or with
 * the sentence set above it as a quotation. Word matching only; no model.
 */
export function LibraryCite({
  onClose,
  onCite,
  onKeep,
}: {
  onClose: () => void;
  /** Cite it at the cursor; `withQuote` sets the passage above the marker as a block quote. */
  onCite: (pick: LibraryPick, withQuote: boolean) => void;
  /** Put a passage on the shelf beside the draft. True when it went. */
  onKeep: (passage: CitablePassage) => Promise<boolean>;
}) {
  const [q, setQ] = useState("");
  const [sources, setSources] = useState<CitableSource[]>([]);
  const [passages, setPassages] = useState<CitablePassage[]>([]);
  const [state, setState] = useState<"idle" | "searching" | "done" | "failed">("idle");
  const [kept, setKept] = useState<Set<string>>(new Set());

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setSources([]);
      setPassages([]);
      setState("idle");
      return;
    }
    setState("searching");
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/drafts/library?q=${encodeURIComponent(term)}`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error("search failed");
        const data = (await res.json()) as { sources: CitableSource[]; passages: CitablePassage[] };
        setSources(data.sources ?? []);
        setPassages(data.passages ?? []);
        setState("done");
      } catch {
        if (!ctrl.signal.aborted) setState("failed");
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const keyOf = (p: CitablePassage) => `${p.chunk_id}:${p.quote}`;

  return (
    <Modal label="Cite from your library" onClose={onClose} width="max-w-2xl" className="max-h-[85vh] overflow-y-auto">
      <h3 className="font-serif text-lg font-semibold">Cite from your library</h3>
      <p className="mt-0.5 text-xs text-[var(--color-muted)]">
        Titles, authors, outlets and the full text of everything in your library, and anything you starred. Word
        matching, no model. The citation goes where your cursor was.
      </p>

      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search your library…"
        aria-label="Search your library to cite"
        className="mt-3 w-full rounded border border-[var(--color-rule)] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
      />

      <div className="mt-3 space-y-4">
        {state === "idle" ? (
          <p className="text-xs text-[var(--color-muted)]">Type two letters or more.</p>
        ) : state === "searching" ? (
          <p className="text-sm text-[var(--color-muted)]">Searching…</p>
        ) : state === "failed" ? (
          <p className="text-sm text-red-800">The search did not work. Try again.</p>
        ) : !sources.length && !passages.length ? (
          <p className="text-sm text-[var(--color-muted)]">Nothing in the library matches those words.</p>
        ) : null}

        {sources.length > 0 && (
          <section>
            <h4 className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">Sources</h4>
            <ul className="mt-1.5 divide-y divide-[var(--color-rule)] rounded-lg border border-[var(--color-rule)]">
              {sources.map((s) => (
                <li key={s.id} className="flex items-start gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium" dir={dirOf(s.title)}>
                      {s.title}
                    </p>
                    <p className="text-xs text-[var(--color-muted)]">
                      {[s.author, s.outlet, s.year].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-xs">
                    <a
                      href={`/sources/${s.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--color-muted)] hover:underline"
                    >
                      Open
                    </a>
                    <button
                      type="button"
                      onClick={() => onCite({ kind: "source", source: s }, false)}
                      title="Cite the source as a whole where the cursor was"
                      className="font-medium text-[var(--color-accent)] hover:underline"
                    >
                      Cite
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {passages.length > 0 && (
          <section>
            <h4 className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">Passages</h4>
            <ul className="mt-1.5 space-y-2">
              {passages.map((p) => {
                const onShelf = kept.has(keyOf(p));
                return (
                  <li key={keyOf(p)} className="rounded-lg border border-[var(--color-rule)] bg-white p-3 text-sm">
                    <p className="italic" dir={dirOf(p.quote)}>
                      “{p.quote}”
                    </p>
                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      {p.citation}
                      {p.outlet && p.outlet !== p.author ? ` · ${p.outlet}` : ""}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs">
                      <button
                        type="button"
                        onClick={() => onCite({ kind: "passage", passage: p }, false)}
                        title="Add the reference and put its marker where the cursor was"
                        className="font-medium text-[var(--color-accent)] hover:underline"
                      >
                        Cite
                      </button>
                      <button
                        type="button"
                        onClick={() => onCite({ kind: "passage", passage: p }, true)}
                        title="Set the sentence in the draft as a block quote, with its citation"
                        className="text-[var(--color-muted)] hover:underline"
                      >
                        Quote and cite
                      </button>
                      <button
                        type="button"
                        disabled={onShelf}
                        onClick={async () => {
                          if (await onKeep(p)) setKept((k) => new Set(k).add(keyOf(p)));
                        }}
                        className="text-[var(--color-muted)] hover:underline disabled:no-underline disabled:opacity-60"
                      >
                        {onShelf ? "On the shelf" : "Keep on the shelf"}
                      </button>
                      <a
                        href={`/sources/${p.source_id}?chunk=${p.chunk_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="ms-auto text-[var(--color-muted)] hover:underline"
                      >
                        Open in the source
                      </a>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}
