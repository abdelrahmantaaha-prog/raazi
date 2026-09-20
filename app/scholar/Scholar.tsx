"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { inputClass } from "../components/ui";
import { ArticleLink } from "../components/ArticleLink";

interface Work {
  kind: "paper" | "book";
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  abstract: string | null;
  citations: number | null;
  url: string | null;
  openAccess: boolean;
  doi: string | null;
  source: "openalex" | "openlibrary";
  sourceId: number | null;
}

/**
 * Ask the literature a question, and pull the answers in.
 *
 * The honesty that matters here is about what arrives. An open-access paper is
 * fetched whole. Everything else comes in as its abstract and is labelled as
 * such, because an abstract cited as though it were the paper is exactly the
 * kind of claim this library exists to make impossible.
 */
export default function Scholar() {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [papers, setPapers] = useState(true);
  const [books, setBooks] = useState(true);
  const [works, setWorks] = useState<Work[] | null>(null);
  const [queries, setQueries] = useState<string[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const keyOf = (w: Work) => w.doi ?? w.url ?? w.title;

  async function run() {
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    setChosen(new Set());
    try {
      const res = await fetch("/api/scholar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "search", question: question.trim(), papers, books }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        works?: Work[];
        queries?: string[];
        problems?: string[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "That search did not work.");
      setWorks(data.works ?? []);
      setQueries(data.queries ?? []);
      setProblems(data.problems ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pullIn(list: Work[]) {
    if (!list.length) return;
    setPulling(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/scholar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "pull",
          works: list.map((w) => ({
            title: w.title,
            url: w.url ?? undefined,
            abstract: w.abstract ?? undefined,
            authors: w.authors,
            year: w.year,
            venue: w.venue,
            openAccess: w.openAccess,
          })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        added?: number;
        skipped?: number;
        failed?: { title: string; error: string }[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "That did not work.");
      setMessage(
        [
          data.added ? `${data.added} added and being read.` : "",
          data.skipped ? `${data.skipped} already in the library.` : "",
          data.failed?.length ? `${data.failed.length} could not be fetched.` : "",
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

  const selected = (works ?? []).filter((w) => chosen.has(keyOf(w)));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-serif text-3xl font-semibold">Books &amp; papers</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-[var(--color-muted)]">
          For what is known rather than what happened — the standard account, the study behind the
          claim, the monograph you should have read. Ask it as a question and the local model turns
          it into the searches a librarian would type. Papers come from OpenAlex, books from Open
          Library; both are free and neither needs a key. For today&rsquo;s news, use{" "}
          <Link href="/discover" className="underline">
            Search news
          </Link>{" "}
          instead.
        </p>
      </header>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <input
            className={`${inputClass} min-w-[18rem] flex-1`}
            placeholder="What does the evidence say about tariffs and manufacturing employment?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
          />
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy || !question.trim()}
            className="rounded-full bg-[var(--color-accent)] px-5 py-1.5 text-sm text-white disabled:opacity-40"
          >
            {busy ? "Searching…" : "Search"}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm text-[var(--color-muted)]">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={papers} onChange={(e) => setPapers(e.target.checked)} /> Papers
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={books} onChange={(e) => setBooks(e.target.checked)} /> Books
          </label>
          {queries.length ? (
            <span className="text-xs">
              searched: {queries.map((q) => `“${q}”`).join(", ")}
            </span>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>
      ) : null}
      {message ? (
        <p className="rounded border border-[var(--color-rule)] bg-[var(--color-accent-soft)] px-3 py-2 text-sm">
          {message}
        </p>
      ) : null}
      {problems.length ? <p className="text-xs text-[var(--color-muted)]">{problems.join(" · ")}</p> : null}

      {works !== null ? (
        works.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--color-rule)] px-6 py-12 text-center">
            <p className="font-serif text-lg">Nothing came back</p>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Try the technical term rather than the plain-language one.
            </p>
          </div>
        ) : (
          <>
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-[var(--color-rule)] bg-white/85 py-2 backdrop-blur">
              <button
                type="button"
                disabled={pulling || !selected.length}
                onClick={() => void pullIn(selected)}
                className="rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-sm text-white disabled:opacity-30"
              >
                {pulling ? "Adding…" : `Add ${selected.length || ""} to the library`}
              </button>
              <span className="text-sm text-[var(--color-muted)]">
                {works.length} results · {works.filter((w) => w.openAccess).length} open access ·{" "}
                {works.filter((w) => w.sourceId).length} already here
              </span>
            </div>

            <ul className="space-y-3">
              {works.map((w) => {
                const key = keyOf(w);
                return (
                  <li
                    key={key}
                    className="flex gap-3 rounded-xl border border-[var(--color-rule)] p-4 transition hover:border-[var(--color-accent)]/50"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                      checked={chosen.has(key)}
                      disabled={Boolean(w.sourceId)}
                      onChange={() =>
                        setChosen((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                      aria-label={`Select ${w.title}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] ${
                            w.kind === "book"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                          }`}
                        >
                          {w.kind}
                        </span>
                        <h2 className="font-medium leading-snug">
                          {w.url ? (
                            <ArticleLink href={w.url} className="hover:text-[var(--color-accent)]">
                              {w.title}
                            </ArticleLink>
                          ) : (
                            w.title
                          )}
                        </h2>
                      </div>

                      <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                        {[
                          w.authors.slice(0, 3).join(", ") + (w.authors.length > 3 ? " et al." : ""),
                          w.venue,
                          w.year,
                          w.citations !== null ? `${w.citations.toLocaleString()} citations` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>

                      {w.abstract ? (
                        <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-muted)]">
                          {w.abstract.slice(0, 380)}
                          {w.abstract.length > 380 ? "…" : ""}
                        </p>
                      ) : null}

                      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs">
                        {w.sourceId ? (
                          <Link href={`/sources/${w.sourceId}`} className="text-[var(--color-accent)] hover:underline">
                            Already in the library
                          </Link>
                        ) : w.openAccess ? (
                          <span className="text-emerald-700">Open access — the full text comes in</span>
                        ) : (
                          <span className="text-amber-700">
                            Not open access — the abstract comes in, labelled as an abstract
                          </span>
                        )}
                        {w.doi ? (
                          <span className="font-mono text-[var(--color-muted)]">
                            {w.doi.replace(/^https?:\/\/doi\.org\//, "")}
                          </span>
                        ) : null}
                        {!w.sourceId ? (
                          <button
                            type="button"
                            disabled={pulling}
                            onClick={() => void pullIn([w])}
                            className="ms-auto text-[var(--color-accent)] hover:underline"
                          >
                            Add it
                          </button>
                        ) : null}
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
