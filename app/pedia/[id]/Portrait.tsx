"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, inputClass } from "../../components/ui";

interface Record {
  id: string;
  label: string;
  description: string | null;
  file: string | null;
  thumb: string | null;
  typeMatches: boolean;
}

/**
 * An entity's picture, and the way to set one by hand.
 *
 * The automatic pass refuses anything it is not certain of, which leaves the
 * ambiguous and the obscure blank on purpose — a confidently wrong photograph
 * on a research entry is worse than none. This is where you settle those.
 *
 * When there is no picture the initial stands in, rather than a broken frame
 * or a grey silhouette: it reads as deliberate, which blankness here is.
 */
export function Portrait({
  entityId,
  name,
  hasPortrait,
  credit,
}: {
  entityId: number;
  name: string;
  hasPortrait: boolean;
  credit?: { wikidata?: string; commons?: string; byYou?: boolean };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(name);
  const [results, setResults] = useState<Record[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Bumped after a change so the browser fetches the new file, not the old one.
  const [version, setVersion] = useState(0);

  const search = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(
        `/api/entities/${entityId}/portrait?candidates=1&q=${encodeURIComponent(q)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed.");
      setResults(data.results);
      if (data.results.length === 0) setNote("Wikidata has nothing with a picture for that.");
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const choose = async (r: Record) => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/entities/${entityId}/portrait`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wikidata: r.id, file: r.file }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not use that picture.");
      setResults(null);
      setNote("Set.");
      setVersion((v) => v + 1);
      router.refresh();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    await fetch(`/api/entities/${entityId}/portrait`, { method: "DELETE" });
    setVersion((v) => v + 1);
    setNote("Removed.");
    setBusy(false);
    router.refresh();
  };

  const showing = hasPortrait || version > 0;

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        title={showing ? "Change this picture" : "Find a picture"}
        className="block h-20 w-20 shrink-0 overflow-hidden rounded-full border border-[var(--color-rule)] bg-[var(--color-accent-soft)] transition hover:border-[var(--color-accent)]"
      >
        {showing ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/entities/${entityId}/portrait?v=${version}`}
            alt=""
            className="h-full w-full object-cover"
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
        ) : (
          <span className="font-serif text-2xl text-[var(--color-accent)]">
            {name.trim().charAt(0)}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 pt-16">
          <div className="w-full max-w-3xl rounded-lg border border-[var(--color-rule)] bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-serif text-lg font-semibold">Picture for {name}</h2>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                  From Wikidata and Wikimedia Commons. Corpus only accepts a match on its own when
                  the name and the kind of thing both agree — everything else is left for you.
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-lg leading-none text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <input
                className={`${inputClass} min-w-[14rem] flex-1`}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void search()}
                placeholder="Name to look up"
              />
              <Button onClick={search} disabled={busy || q.trim().length < 2}>
                {busy ? "Searching…" : "Search"}
              </Button>
              {showing && (
                <button
                  onClick={clear}
                  disabled={busy}
                  className="rounded border border-[var(--color-rule)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
                >
                  Remove
                </button>
              )}
            </div>

            {note && <p className="mt-3 text-sm text-[var(--color-accent)]">{note}</p>}

            {credit?.wikidata && (
              <p className="mt-3 text-xs text-[var(--color-muted)]">
                Currently{" "}
                <a
                  href={`https://www.wikidata.org/wiki/${credit.wikidata}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {credit.wikidata}
                </a>
                {credit.commons ? ` — ${credit.commons}` : ""}
                {credit.byYou ? " (your choice)" : ""}. Images on Commons are freely licensed;
                check the file page before republishing one.
              </p>
            )}

            {results && results.length > 0 && (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {results.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => choose(r)}
                    disabled={busy}
                    className="group text-left"
                    title={`${r.label} — ${r.description ?? "no description"}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={r.thumb!}
                      alt=""
                      loading="lazy"
                      className="aspect-square w-full rounded object-cover ring-1 ring-black/10 transition group-hover:ring-2 group-hover:ring-[var(--color-accent)]"
                    />
                    <p className="mt-1 line-clamp-2 text-xs font-medium leading-snug">
                      {r.label}
                      {/* The type check is the strong signal, so it is shown. */}
                      {r.typeMatches && <span className="ml-1 text-[var(--color-accent)]">✓</span>}
                    </p>
                    <p className="line-clamp-2 text-[0.7rem] text-[var(--color-muted)]">
                      {r.description ?? r.id}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
