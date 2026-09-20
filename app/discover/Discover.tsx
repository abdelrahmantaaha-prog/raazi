"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Empty, inputClass } from "../components/ui";
import { relativeDate } from "@/lib/dates";
import { ArticleLink } from "../components/ArticleLink";

interface Result {
  title: string;
  url: string | null;
  summary: string | null;
  publishedAt: string | null;
  outlet: string | null;
  engine: "google" | "bing";
  readable: boolean;
  sourceId: number | null;
}

/**
 * Search the news, choose, pull in.
 *
 * The three states this page has to be honest about, because they decide what
 * a result is worth: already in the library (nothing to do), readable (pulling
 * it in gets you the article), and headline-only (the search engine will not
 * say where the piece actually lives, so pulling it in gets you a dated
 * headline and a summary — real, citable, and not the piece).
 */
export default function Discover() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    setChosen(new Set());
    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "search", query: query.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        results?: Result[];
        problems?: string[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "That search did not work.");
      setResults(data.results ?? []);
      setProblems(data.problems ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pullIn(items: Result[]) {
    if (!items.length) return;
    setPulling(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "pull",
          items: items.map((r) => ({
            url: r.url,
            title: r.title,
            publishedAt: r.publishedAt ?? undefined,
            outlet: r.outlet ?? undefined,
            summary: r.summary ?? undefined,
          })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        added?: number;
        skipped?: number;
        failed?: { url: string; error: string }[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "That did not work.");
      setMessage(
        [
          data.added ? `${data.added} pulled in and being read.` : "",
          data.skipped ? `${data.skipped} already in the library.` : "",
          data.failed?.length ? `${data.failed.length} would not open.` : "",
        ]
          .filter(Boolean)
          .join(" ")
      );
      setChosen(new Set());
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPulling(false);
    }
  }

  const keyOf = (r: Result) => r.url ?? `${r.engine}:${r.title}`;
  const selected = (results ?? []).filter((r) => chosen.has(keyOf(r)));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-serif text-2xl font-semibold">Search the news</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-[var(--color-muted)]">
          For something you are chasing today rather than following every day. Google News and Bing are
          both asked; what you pull in is read straight away and joins this week, exactly as if you had
          kept it from the <Link href="/inbox" className="underline">inbox</Link>. To follow a phrase
          from now on instead, add it as a watch on the <Link href="/feeds" className="underline">Feeds</Link> page.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        <input
          className={`${inputClass} min-w-[16rem] flex-1`}
          placeholder="tariff exemption, softwood lumber, Section 232…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
        />
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || !query.trim()}
          className="rounded bg-[var(--color-accent)] px-4 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {busy ? "Searching…" : "Search"}
        </button>
      </div>

      {error ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>
      ) : null}
      {message ? (
        <p className="rounded border border-[var(--color-rule)] bg-[var(--color-accent-soft)] px-3 py-2 text-sm">
          {message}
        </p>
      ) : null}
      {problems.length ? (
        <p className="text-xs text-[var(--color-muted)]">{problems.join(" · ")}</p>
      ) : null}

      {results !== null ? (
        results.length === 0 ? (
          <Empty title="Nothing came back" hint="Try fewer words, or a name rather than a phrase." />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-rule)] pb-2">
              <button
                type="button"
                disabled={pulling || !selected.length}
                onClick={() => void pullIn(selected)}
                className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
              >
                {pulling ? "Pulling in…" : `Pull in ${selected.length || ""}`}
              </button>
              <span className="text-sm text-[var(--color-muted)]">
                {results.length} result{results.length === 1 ? "" : "s"} ·{" "}
                {results.filter((r) => r.readable).length} openable ·{" "}
                {results.filter((r) => r.sourceId).length} already here
              </span>
            </div>

            <ul className="space-y-3">
              {results.map((r) => {
                const key = keyOf(r);
                return (
                  <li key={key} className="flex gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                      checked={chosen.has(key)}
                      disabled={Boolean(r.sourceId) || !r.url}
                      onChange={() =>
                        setChosen((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                      aria-label={`Select ${r.title}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <h2 className="font-medium">
                          {r.url ? (
                            <ArticleLink href={r.url} className="hover:text-[var(--color-accent)]">
                              {r.title}
                            </ArticleLink>
                          ) : (
                            r.title
                          )}
                        </h2>
                        <span className="text-xs text-[var(--color-muted)]">
                          {[r.outlet, r.publishedAt ? relativeDate(r.publishedAt) : null, r.engine]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </div>
                      {r.summary ? (
                        <p className="mt-0.5 text-sm text-[var(--color-muted)]">{r.summary}</p>
                      ) : null}
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                        {r.sourceId ? (
                          <Link href={`/sources/${r.sourceId}`} className="text-[var(--color-accent)] hover:underline">
                            Already in the library
                          </Link>
                        ) : r.readable ? (
                          <button
                            type="button"
                            disabled={pulling}
                            onClick={() => void pullIn([r])}
                            className="text-[var(--color-accent)] hover:underline"
                          >
                            Pull it in
                          </button>
                        ) : (
                          <span className="text-amber-700">
                            The search engine will not say where this lives — pulling it in keeps the
                            headline and summary, not the article.
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )
      ) : null}
    </div>
  );
}
