"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Modal } from "./Modal";
import { ArticleLink } from "./ArticleLink";
import { IconCheck, IconReview, IconShelf } from "./Icons";
import { relativeDate } from "@/lib/dates";
import { dirOf } from "@/lib/dir";
import type { LitResult, LitReview, LitTarget } from "@/lib/litreview";

/** Kept here rather than imported, so this client file takes nothing from the server module. */
const RESEARCH = new Set(["paper", "report", "book"]);
const KIND_LABEL: Record<string, string> = {
  paper: "Paper",
  report: "Report",
  book: "Book",
  news: "News",
  analysis: "Analysis",
};

export interface LitReviewTarget {
  target: LitTarget;
  id: number;
  /** A highlighted passage: the subject of the review. */
  focus?: string;
  /** The paragraph around it, for context. */
  context?: string;
}

/**
 * The "Literature review & news" button: opens the window below.
 *
 * Used on an article in the inbox, on a draft, and on a passage highlighted in
 * the reader. `onOpen` lets a caller close a popup the button sits in.
 */
export function LitReviewButton({
  className,
  label = "Literature review & news",
  disabled,
  onOpen,
  pickFocus,
  ...what
}: LitReviewTarget & {
  className?: string;
  label?: string;
  disabled?: boolean;
  onOpen?: () => void;
  /** Read at the moment of the click: a passage selected in the text, to review instead of the whole. */
  pickFocus?: () => { focus: string; context?: string } | null;
}) {
  const [open, setOpen] = useState<LitReviewTarget | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setOpen({ ...what, ...(pickFocus?.() ?? {}) });
          onOpen?.();
        }}
        title="Claude searches for research, papers and news on this, and writes a short review of what has been written — on your plan's allowance"
        className={
          className ??
          "inline-flex items-center gap-1.5 rounded-full border border-[var(--color-rule)] px-3 py-1 text-sm transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-30"
        }
      >
        <IconReview /> {label}
      </button>
      {open ? <LitReviewWindow {...open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/**
 * The window: the last review of this text if there is one, or a new search
 * started at once if there is not. A search takes minutes; the window can be
 * closed meanwhile, and the result is waiting the next time it is opened.
 */
export function LitReviewWindow({ target, id, focus, context, onClose }: LitReviewTarget & { onClose: () => void }) {
  const [review, setReview] = useState<LitReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<number | null>(null);

  const start = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/litreview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", target, id, focus, context }),
      });
      const data = (await res.json().catch(() => ({}))) as { reviewId?: number; error?: string };
      if (!res.ok && res.status !== 202) throw new Error(data.error ?? "The search could not start.");
      if (!data.reviewId) throw new Error("The search could not start.");
      const one = await fetch(`/api/litreview?id=${data.reviewId}`, { cache: "no-store" });
      setReview(((await one.json()) as { review: LitReview }).review);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [target, id, focus, context]);

  // The last review of exactly this — this draft, this article, this passage —
  // or a new one.
  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const q = new URLSearchParams({ target, targetId: String(id), focus: focus ?? "" });
        const res = await fetch(`/api/litreview?${q}`, { cache: "no-store" });
        const data = (await res.json()) as { reviews?: LitReview[]; canSearch?: boolean; error?: string };
        if (stopped) return;
        const last = data.reviews?.[0];
        if (last) setReview(last);
        else if (data.canSearch === false)
          setError("A literature review needs Claude (your plan), which searches the web. Add it in Settings → AI first.");
        else await start();
      } catch {
        if (!stopped) setError("Corpus did not answer. Is it still running?");
      } finally {
        if (!stopped) setLoading(false);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [target, id, focus, start]);

  // While it searches, look again every few seconds.
  const reviewId = review?.id;
  const searching = review?.state === "running" || review?.state === "waiting";
  useEffect(() => {
    if (!reviewId || !searching) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/litreview?id=${reviewId}`, { cache: "no-store" });
        if (res.ok) setReview(((await res.json()) as { review: LitReview }).review);
      } catch {
        /* the next look tries again */
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [reviewId, searching]);

  async function add(index: number) {
    if (!review) return;
    setAdding(index);
    setError(null);
    try {
      const res = await fetch("/api/litreview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "add", reviewId: review.id, index }),
      });
      const data = (await res.json().catch(() => ({}))) as { review?: LitReview; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not add it.");
      if (data.review) setReview(data.review);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(null);
    }
  }

  const report = review?.report ?? null;
  const numbered = (report?.results ?? []).map((r, i) => ({ r, n: i + 1 }));
  const research = numbered.filter(({ r }) => RESEARCH.has(r.kind));
  const news = numbered.filter(({ r }) => !RESEARCH.has(r.kind));
  const subject = focus ?? review?.title ?? "";

  return (
    <Modal label="Literature review & news" onClose={onClose} width="max-w-3xl" className="max-h-[85vh] overflow-y-auto">
      <div className="space-y-4">
        <header className="space-y-1.5 pe-6">
          <h2 className="flex items-center gap-2 font-serif text-xl font-semibold">
            <IconReview size={18} /> Literature review &amp; news
          </h2>
          {subject ? (
            <p dir={dirOf(subject)} className={`text-sm text-[var(--color-muted)] ${focus ? "line-clamp-3 border-s-2 border-[var(--color-rule)] ps-2 italic" : ""}`}>
              {focus ? subject : <>On {subject}</>}
            </p>
          ) : null}
        </header>

        {error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p> : null}

        {loading && !review ? (
          <p className="text-sm text-[var(--color-muted)]">Opening…</p>
        ) : review && searching ? (
          <div className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-accent-soft)]/30 px-4 py-6 text-center">
            <p className="font-medium">
              <span className="me-2 inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
              {review.state === "waiting" ? "Waiting" : "Claude is searching papers, reports and the news"}
            </p>
            <p className="mx-auto mt-1 max-w-[52ch] text-sm text-[var(--color-muted)]">
              {review.note ??
                "This usually takes a few minutes. You can close this window and carry on — the result is kept and shows here when you press the button again."}
            </p>
          </div>
        ) : review?.state === "failed" ? (
          <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p>The search did not finish: {review.note}</p>
            <button type="button" onClick={() => void start()} className="font-medium underline">
              Try again
            </button>
          </div>
        ) : report ? (
          <>
            {report.overview ? (
              <section dir={dirOf(report.overview)} className="rounded-lg bg-[var(--color-accent-soft)]/35 px-4 py-3 font-serif text-[0.95rem] leading-relaxed">
                <Overview text={report.overview} count={report.results.length} />
              </section>
            ) : null}
            {report.partial ? <p className="text-xs text-[var(--color-muted)]">{report.partial}</p> : null}

            {report.results.length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">Nothing was found that Claude could open and check.</p>
            ) : null}
            {research.length ? (
              <ResultList title="Research, papers and reports" items={research} adding={adding} onAdd={add} />
            ) : null}
            {news.length ? <ResultList title="News and analysis" items={news} adding={adding} onAdd={add} /> : null}

            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-rule)] pt-3 text-xs text-[var(--color-muted)]">
              <span>
                Searched {relativeDate(report.searchedAt)}
                {report.dropped
                  ? ` · ${report.dropped} more named but never opened, so left out`
                  : ""}
              </span>
              <button
                type="button"
                onClick={() => void start()}
                className="rounded-full border border-[var(--color-rule)] px-3 py-1 text-sm text-[var(--color-ink)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                Search again
              </button>
            </footer>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

/** The review's prose, its [1] [2] citations made into links to the results below. */
function Overview({ text, count }: { text: string; count: number }) {
  const parts = text.split(/(\[\d+(?:,\s*\d+)*\])/g);
  return (
    <p className="whitespace-pre-line">
      {parts.map((part, i) => {
        const m = /^\[(\d+(?:,\s*\d+)*)\]$/.exec(part);
        if (!m) return <Fragment key={i}>{part}</Fragment>;
        const nums = m[1].split(/,\s*/).map(Number).filter((n) => n >= 1 && n <= count);
        return (
          <sup key={i} className="ms-0.5 font-sans text-[0.7rem]">
            {nums.map((n, j) => (
              <Fragment key={n}>
                {j ? "," : ""}
                <a
                  href={`#lit-${n}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(`lit-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                  }}
                  className="text-[var(--color-accent)] hover:underline"
                >
                  {n}
                </a>
              </Fragment>
            ))}
          </sup>
        );
      })}
    </p>
  );
}

function ResultList({
  title,
  items,
  adding,
  onAdd,
}: {
  title: string;
  items: { r: LitResult; n: number }[];
  adding: number | null;
  onAdd: (index: number) => void;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">{title}</h3>
      <ol className="divide-y divide-[var(--color-rule)] rounded-lg border border-[var(--color-rule)]">
        {items.map(({ r, n }) => {
          const meta = [r.authors, r.outlet, r.date].filter(Boolean).join(" · ");
          return (
            <li key={n} id={`lit-${n}`} className="flex gap-3 px-3 py-2.5">
              <span className="w-5 shrink-0 pt-0.5 text-end text-xs text-[var(--color-muted)]">{n}</span>
              <div className="min-w-0 flex-1 space-y-1">
                <p dir={dirOf(r.title)} className="text-sm font-medium leading-snug">
                  <span className="me-1.5 rounded-full bg-slate-100 px-1.5 py-px align-[1px] text-[10px] font-medium text-slate-600">
                    {KIND_LABEL[r.kind] ?? r.kind}
                  </span>
                  <ArticleLink href={r.url} className="hover:text-[var(--color-accent)] [overflow-wrap:anywhere]">
                    {r.title}
                  </ArticleLink>
                </p>
                {meta ? <p className="text-xs text-[var(--color-muted)]">{meta}</p> : null}
                {r.finding ? (
                  <p dir={dirOf(r.finding)} className="text-sm leading-snug">
                    {r.finding}
                  </p>
                ) : null}
                {r.why ? (
                  <p dir={dirOf(r.why)} className="text-xs italic leading-snug text-[var(--color-muted)]">
                    {r.why}
                  </p>
                ) : null}
              </div>
              <div className="shrink-0 pt-0.5">
                {r.sourceId ? (
                  <Link
                    href={`/sources/${r.sourceId}`}
                    className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline"
                  >
                    <IconCheck size={13} /> In library
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled={adding !== null}
                    onClick={() => onAdd(n - 1)}
                    title="Add it to the library, read like any other source"
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--color-rule)] px-2 py-0.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
                  >
                    <IconShelf size={13} /> {adding === n - 1 ? "Adding…" : "Add"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
