"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "../../components/ui";

interface Summary {
  id: number;
  title: string;
  lang: string | null;
  author: string | null;
  pairs: number;
  covered: number;
}

interface Candidate {
  id: number;
  title: string;
  author: string | null;
  year: string | null;
  outlet: string | null;
}

/**
 * Pairing a book with its translation.
 *
 * The translation is an ordinary source: you add it to the library the way you
 * add any book, and then say here what it renders. Doing it the other way
 * round — a special import that ingests two files at once — would mean a
 * second ingest path to keep working for every format, and would stop you
 * pairing two books you already had.
 *
 * Matching is instant and costs nothing: rare tokens that survive translation
 * pin the correspondence and character lengths fill in between them. No model
 * reads either text. What it could not settle it reports as coverage rather
 * than quietly guessing, so a translation that matched a third of the book
 * says so.
 */
export function Translations({ sourceId, initial }: { sourceId: number; initial: Summary[] }) {
  const [list, setList] = useState<Summary[]>(initial);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/drafts/library?q=${encodeURIComponent(term)}`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { sources: Candidate[] };
        setHits((data.sources ?? []).filter((s) => s.id !== sourceId).slice(0, 8));
      } catch {
        /* a search that did not land; the box simply shows nothing */
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, sourceId]);

  const pair = async (translationId: number) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/sources/${sourceId}/translations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ translationId }),
      });
      const data = (await res.json()) as { error?: string; pairs?: number; covered?: number; translations?: Summary[] };
      if (!res.ok) throw new Error(data.error ?? "That did not work.");
      setList(data.translations ?? []);
      setMessage(
        `Matched ${data.pairs ?? 0} passages — ${Math.round((data.covered ?? 0) * 100)}% of the book found a partner.`
      );
      setOpen(false);
      setQ("");
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (translationId: number) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/sources/${sourceId}/translations?translationId=${translationId}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { translations?: Summary[] };
      setList(data.translations ?? []);
      setMessage(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-[var(--color-rule)] bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">
          Translations
        </h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-medium text-[var(--color-accent)] hover:underline"
        >
          {open ? "Never mind" : "Add a translation"}
        </button>
      </div>

      {list.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {list.map((t) => (
            <li key={t.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
              <Link href={`/sources/${t.id}`} className="font-medium hover:underline">
                {t.title}
              </Link>
              <span className="tabular-nums text-xs text-[var(--color-muted)]">
                {t.pairs} passages · {Math.round(t.covered * 100)}% matched
              </span>
              <Link
                href={`/sources/${sourceId}/bilingual?with=${t.id}`}
                className="text-xs font-medium text-[var(--color-accent)] hover:underline"
              >
                Read bilingually
              </Link>
              <button
                type="button"
                disabled={busy}
                onClick={() => void pair(t.id)}
                className="text-xs text-[var(--color-muted)] hover:underline"
                title="Work the matching out again — after re-reading either book, say"
              >
                Match again
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void unlink(t.id)}
                className="text-xs text-[var(--color-muted)] hover:text-red-700"
              >
                Unpair
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-[var(--color-muted)]">
            The translation has to be in your library already — add it as a source, then find it here.
          </p>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find the translation by title or author…"
            aria-label="Find the translation in your library"
            className="w-full rounded border border-[var(--color-rule)] bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
          />
          {hits.length > 0 && (
            <ul className="divide-y divide-[var(--color-rule)] rounded border border-[var(--color-rule)]">
              {hits.map((h) => (
                <li key={h.id} className="flex items-center gap-3 px-2.5 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {h.title}
                    {h.author && <span className="text-xs text-[var(--color-muted)]"> · {h.author}</span>}
                  </span>
                  <Button variant="ghost" disabled={busy} onClick={() => void pair(h.id)}>
                    Pair
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {message && <p className="mt-2 text-xs text-[var(--color-muted)]">{message}</p>}
      {list.length === 0 && !open && (
        <p className="mt-1.5 text-xs text-[var(--color-muted)]">
          None yet. Pair one and you can read the two side by side, passage against passage.
        </p>
      )}
    </section>
  );
}
