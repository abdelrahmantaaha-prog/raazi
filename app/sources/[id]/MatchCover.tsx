"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, inputClass } from "../../components/ui";
import { SHELVES, type Shelf } from "@/lib/shelves";

interface Edition {
  coverId: number;
  title: string;
  author: string | null;
  year: number | null;
  publisher: string | null;
  pages: number | null;
  thumb: string;
}

/**
 * Fixing the two things Raazi can only guess at: what kind of thing a source
 * is, and which published edition it is.
 *
 * Both guesses are deliberately cautious — a wrong cover on a research source
 * is worse than a blank one — so this is where you settle the ones it left
 * alone.
 */
export function MatchCover({
  sourceId,
  title,
  shelf,
  guessed,
}: {
  sourceId: number;
  title: string;
  shelf: string | null;
  guessed: Shelf;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(title);
  const [results, setResults] = useState<Edition[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [useTitle, setUseTitle] = useState(false);

  const search = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/sources/${sourceId}/match?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed.");
      setResults(data.results);
      if (data.results.length === 0) setNote("Open Library has nothing with a cover for that.");
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const choose = async (e: Edition) => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/sources/${sourceId}/match`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...e, useTitle }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not use that edition.");
      setNote("Matched. The cover is now stored with the source.");
      setResults(null);
      // The cover is served from a cached URL, so force the browser past it.
      router.refresh();
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setShelf = async (value: string) => {
    await fetch(`/api/sources/${sourceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shelf: value || null }),
    });
    router.refresh();
  };

  return (
    <div className="rounded-lg border border-[var(--color-rule)] bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 text-left text-sm font-medium"
      >
        {open ? "▾" : "▸"} Fix how this source is filed and pictured
      </button>

      {open && (
        <div className="space-y-5 border-t border-[var(--color-rule)] p-4">
          <div>
            <p className="text-sm font-medium">Where it belongs in the Library</p>
            <p className="mt-0.5 text-xs text-[var(--color-muted)]">
              Raazi guessed <strong>{SHELVES.find((s) => s.id === guessed)?.label}</strong> from the
              file type and length. Your choice sticks.
            </p>
            <select
              className={`${inputClass} mt-2 max-w-sm`}
              value={shelf ?? ""}
              onChange={(e) => setShelf(e.target.value)}
            >
              <option value="">
                Let Raazi decide (currently {SHELVES.find((s) => s.id === guessed)?.label})
              </option>
              {SHELVES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} — {s.note}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="text-sm font-medium">Match it to a published edition</p>
            <p className="mt-0.5 text-xs text-[var(--color-muted)]">
              Searches Open Library. Picking one stores its cover, and fills in author, year and
              publisher only where you have none — those go into your citations, so anything you
              have already typed is left alone.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                className={`${inputClass} min-w-[16rem] flex-1`}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void search()}
                placeholder="Title, or title and author"
              />
              <Button onClick={search} disabled={busy || q.trim().length < 3}>
                {busy ? "Searching…" : "Search"}
              </Button>
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs text-[var(--color-muted)]">
              <input
                type="checkbox"
                checked={useTitle}
                onChange={(e) => setUseTitle(e.target.checked)}
              />
              Also rename this source to the edition&rsquo;s title
            </label>
          </div>

          {note && <p className="text-sm text-[var(--color-accent)]">{note}</p>}

          {results && results.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {results.map((e) => (
                <button
                  key={e.coverId}
                  onClick={() => choose(e)}
                  disabled={busy}
                  className="group text-left"
                  title={[e.title, e.author, e.year].filter(Boolean).join(" · ")}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={e.thumb}
                    alt=""
                    loading="lazy"
                    className="aspect-[2/3] w-full rounded object-cover ring-1 ring-black/10 transition group-hover:ring-2 group-hover:ring-[var(--color-accent)]"
                  />
                  <p className="mt-1 line-clamp-2 text-xs font-medium leading-snug">{e.title}</p>
                  <p className="truncate text-[0.7rem] text-[var(--color-muted)]">
                    {[e.author, e.year].filter(Boolean).join(" · ")}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
