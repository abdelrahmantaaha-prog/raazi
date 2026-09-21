"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { dirOf } from "@/lib/dir";
import { Button } from "../components/ui";

interface Found {
  chunkId: number;
  sourceId: number;
  sourceTitle: string;
  author: string | null;
  outlet: string | null;
  locator: string;
  text: string;
  score: number;
  via: "meaning" | "words" | "both";
}

interface Coverage {
  chunks: number;
  embedded: number;
  stale: number;
}

const VIA: Record<Found["via"], string> = {
  both: "by meaning and words",
  meaning: "by meaning",
  words: "by words",
};

/**
 * Asking the library a question and getting passages.
 *
 * The distinction this page exists to hold: it returns what your sources say,
 * not what a model says they say. Every row is a passage that is in the
 * library, with the source and the place in it, and opens at that passage.
 * Nothing on this page was written by a model — the question becomes a vector
 * and the ranking is arithmetic.
 *
 * Indexing is a button rather than something the search does for itself. It
 * is the only part that spends anything, and a search that quietly embedded
 * the whole library on its first use would be a surprise on a metered key.
 */
export function Meaning() {
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const [results, setResults] = useState<Found[] | null>(null);
  const [cov, setCov] = useState<Coverage | null>(null);
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/ask", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setCov(d.coverage))
      .catch(() => setCov(null));
  }, []);

  const ask = async () => {
    const question = q.trim();
    if (!question) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "The search did not work.");
      setResults(data.results ?? []);
      setCov(data.coverage ?? cov);
      setAsked(question);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const index = async () => {
    setIndexing(true);
    setError(null);
    try {
      // A batch at a time, until there is nothing left or it stops making
      // progress — so a big library is a few minutes of clicking nothing
      // rather than one request that times out.
      for (let i = 0; i < 60; i++) {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "index", limit: 128 }),
        });
        const data = await res.json();
        if (!res.ok) {
          // Running out of quota partway is an ordinary end to a long errand,
          // not a failure: everything already indexed stays indexed and the
          // button picks up where it left off. Said plainly rather than shown
          // as an error, which would suggest starting over.
          setError(`${data.error ?? "Indexing stopped."} What is done is kept — press it again later.`);
          break;
        }
        setCov(data.coverage ?? null);
        if (!data.indexed) break;
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIndexing(false);
    }
  };

  const left = cov ? cov.chunks - cov.embedded : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void ask();
          }}
          placeholder="What were people saying about the cost of the war before the CBO number?"
          aria-label="Ask your sources"
          className="min-w-0 flex-1 rounded border border-[var(--color-rule)] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        />
        <Button variant="primary" onClick={() => void ask()} disabled={busy || !q.trim()}>
          {busy ? "Looking…" : "Ask"}
        </Button>
      </div>

      <p className="text-xs text-[var(--color-muted)]">
        Passages from your own sources, ranked by how close they are to the question — not an answer
        written about them. Word matching is blended in, so a name or a figure in the question still
        counts.
        {cov && (
          <>
            {" "}
            <span className="tabular-nums">
              {cov.embedded.toLocaleString()} of {cov.chunks.toLocaleString()} passages can be searched this
              way.
            </span>
            {left > 0 && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => void index()}
                  disabled={indexing}
                  className="font-medium text-[var(--color-accent)] hover:underline disabled:opacity-60"
                >
                  {indexing ? "Indexing…" : `Index the other ${left.toLocaleString()}`}
                </button>
              </>
            )}
          </>
        )}
      </p>

      {error && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
      )}

      {results !== null && (
        <div className="space-y-2">
          <p className="text-sm text-[var(--color-muted)]">
            {results.length === 0
              ? `Nothing in the library came close to “${asked}”.`
              : `${results.length} passage${results.length === 1 ? "" : "s"} for “${asked}”`}
          </p>

          <ol className="space-y-2">
            {results.map((r) => (
              <li key={r.chunkId} className="rounded-lg border border-[var(--color-rule)] bg-white p-3">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-[var(--color-muted)]">
                  <Link
                    href={`/sources/${r.sourceId}?chunk=${r.chunkId}`}
                    className="font-medium text-[var(--color-ink)] hover:underline"
                  >
                    {r.sourceTitle}
                  </Link>
                  {r.author && <span>· {r.author}</span>}
                  {r.outlet && r.outlet !== r.author && <span>· {r.outlet}</span>}
                  {r.locator && <span>· {r.locator}</span>}
                  <span className="ms-auto tabular-nums">
                    {Math.round(r.score * 100)}% {VIA[r.via]}
                  </span>
                </div>
                <p dir={dirOf(r.text)} className="mt-1.5 text-sm leading-relaxed">
                  {r.text.length > 700 ? `${r.text.slice(0, 700)}…` : r.text}
                </p>
                <Link
                  href={`/sources/${r.sourceId}?chunk=${r.chunkId}`}
                  className="mt-1.5 inline-block text-xs text-[var(--color-accent)] hover:underline"
                >
                  Read it in the source
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
