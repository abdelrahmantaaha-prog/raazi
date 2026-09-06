"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, Empty, Progress } from "./components/ui";
import { AddSource } from "./components/AddSource";
import { SourceCover } from "./components/SourceCover";
import { READING_STATES, readingStateOf, shelfOf } from "@/lib/shelves";
import { formatDate, formatDateTime, parseDate, relativeDate } from "@/lib/dates";

interface Run {
  id: number;
  label: string | null;
  state: string;
  source_id: number | null;
  source_title: string | null;
  resume_at: string | null;
  tokens_in: number;
  tokens_out: number;
  budget_cap: number | null;
  last_error: string | null;
  total: number;
  done: number;
  failed: number;
  pending: number;
  /** Which model(s) answered, comma-separated; null until one has. */
  models: string | null;
}

interface SourceRow {
  id: number;
  title: string;
  author: string | null;
  kind: string;
  status: string;
  note: string | null;
  chunks: number;
  read_chunks: number;
  entities: number;
  bookmarks: number;
  added_at: string;
  publisher?: string | null;
  year?: string | null;
  url?: string | null;
  bookmark_chunk?: number | null;
  shelf?: string | null;
  words?: number;
  progress?: number;
  read_mode?: string | null;
  read_at?: string | null;
  reading_state?: string | null;
}

interface Totals {
  entities: number;
  mentions: number;
  entries: number;
  stale: number;
}

interface StaleInfo {
  total: number;
  rewrites: number;
  newEntries: number;
}

const STATE_LABEL: Record<string, { text: string; tone: "running" | "warn" | "danger" | "ok" | "quiet" }> = {
  queued: { text: "Queued", tone: "quiet" },
  running: { text: "Running", tone: "running" },
  paused_quota: { text: "Out of quota", tone: "warn" },
  paused_user: { text: "Paused", tone: "quiet" },
  paused_budget: { text: "Budget spent", tone: "warn" },
  paused_key: { text: "Key problem", tone: "danger" },
  done: { text: "Done", tone: "ok" },
  failed: { text: "Finished with errors", tone: "danger" },
};

const SHELF_ORDER = ["books", "reading", "watching"] as const;

/** How many of the newest arrivals the chronological strip shows. */
const RECENT = 10;

/** How many articles or notes a page of the shelf holds. */
const PER_PAGE = 10;

/**
 * A shelf that comes in pages.
 *
 * The reading shelf was one long list, which was fine at forty articles and is
 * not at four hundred: a beat adds a dozen a day, and a list you have to scroll
 * past to reach anything else stops being a shelf and becomes a wall. Ten at a
 * time, with the count said plainly, and the page resets when what it is
 * showing changes underneath it.
 */
function Paged<T>({
  items,
  perPage,
  children,
}: {
  items: T[];
  perPage: number;
  children: (page: T[]) => React.ReactNode;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(page, pages - 1);
  const from = current * perPage;
  const slice = items.slice(from, from + perPage);

  return (
    <div className="space-y-3">
      {children(slice)}
      {pages > 1 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button
            type="button"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
            className="rounded border border-[var(--color-rule)] px-2.5 py-1 transition hover:border-[var(--color-accent)] disabled:opacity-30"
          >
            Newer
          </button>
          <button
            type="button"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
            className="rounded border border-[var(--color-rule)] px-2.5 py-1 transition hover:border-[var(--color-accent)] disabled:opacity-30"
          >
            Older
          </button>
          <span className="text-[var(--color-muted)]">
            {from + 1}–{Math.min(from + perPage, items.length)} of {items.length}
          </span>
          {pages <= 12 ? (
            <span className="ms-auto flex flex-wrap gap-1">
              {Array.from({ length: pages }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setPage(i)}
                  className={`h-7 w-7 rounded text-xs transition ${
                    i === current
                      ? "bg-[var(--color-accent)] text-white"
                      : "border border-[var(--color-rule)] hover:border-[var(--color-accent)]"
                  }`}
                >
                  {i + 1}
                </button>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A run still has somewhere to go. Failed runs are finished, just badly. */
const isActive = (r: Run) => r.state !== "done" && r.state !== "failed";

/**
 * The Library is a shelf, and a shelf is the books on it.
 *
 * Everything that is not a source — what the queue is doing, how many tokens it
 * has spent, the form for adding more — used to sit above the collection, so
 * the page opened on machinery and you scrolled past it to reach the reading.
 * That ordering is right for a job runner and wrong for a library. The books
 * come first now; the machinery is at the bottom, where you go when you want it.
 */
export default function Library() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [stale, setStale] = useState<StaleInfo | null>(null);
  const [pictures, setPictures] = useState<{
    entries: number;
    withPicture: number;
    checked: number;
    pending: number;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);

  /**
   * The stale-entries and portrait badges, fetched apart from the run list.
   *
   * These were on the 1.5-second poll, and they are the two most expensive
   * reads in the app — staleCount substring-scans every entry body against
   * every mention. Nothing about them changes at poll speed: they move when a
   * run finishes, so that is when they are asked for (plus once on mount, and
   * after the buttons that change them).
   */
  const loadBadges = useCallback(async () => {
    try {
      setStale(await (await fetch("/api/entries/refresh", { cache: "no-store" })).json());
      setPictures(await (await fetch("/api/portraits", { cache: "no-store" })).json());
    } catch {
      // Keep showing the last numbers rather than blanking the badges.
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/runs", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setRuns(data.runs ?? []);
      setSources(data.sources ?? []);
      setTotals(data.totals ?? null);
      const busy = (data.runs ?? []).some(
        (r: Run) => r.state === "running" || r.state === "queued"
      );
      // Work finishing is what changes the badges, so that edge refreshes them.
      if (busyRef.current && !busy) void loadBadges();
      busyRef.current = busy;
    } catch {
      // A server restart or a laptop waking from sleep drops one request. The
      // last numbers stay on screen and the next tick asks again — this used
      // to throw before the timer was re-armed, and the page froze for good.
    } finally {
      setLoaded(true);
    }
  }, [loadBadges]);

  // Poll while anything is moving; back off to a slow tick when it isn't. The
  // busy flag is a ref rather than state because the effect runs once and would
  // otherwise close over the empty first render for ever — which it did, so the
  // page polled every eight seconds even mid-ingest.
  //
  // Nothing is asked for while the tab is hidden: three aggregate queries every
  // eight seconds in a background tab is work for nobody. The first tick after
  // it comes back is immediate.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (cancelled || inFlight) return;
      if (document.hidden) return;
      inFlight = true;
      try {
        await load();
      } finally {
        inFlight = false;
      }
      if (cancelled || document.hidden) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(tick, busyRef.current ? 1500 : 8000);
    };
    const onVisibility = () => {
      if (timer.current) clearTimeout(timer.current);
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void tick();
    void loadBadges();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, loadBadges]);

  const [error, setError] = useState<string | null>(null);

  const act = async (runId: number, action: string, budgetCap?: number) => {
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, budgetCap }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Could not ${action} that run.`);
      }
    } catch (err) {
      setError((err as Error).message);
    }
    void load();
  };

  const setReadingState = async (id: number, readingState: string | null) => {
    // Optimistic: the shelf regroups as you choose, rather than after a round
    // trip — and goes back where it was if the round trip fails.
    const before = sources.find((r) => r.id === id)?.reading_state ?? null;
    setSources((rows) =>
      rows.map((r) => (r.id === id ? { ...r, reading_state: readingState } : r))
    );
    try {
      const res = await fetch(`/api/sources/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ readingState }),
      });
      if (!res.ok) throw new Error("Could not move it.");
    } catch (err) {
      setSources((rows) => rows.map((r) => (r.id === id ? { ...r, reading_state: before } : r)));
      setError((err as Error).message);
    }
  };

  const removeSource = async (id: number, title: string) => {
    if (
      !confirm(
        `Remove "${title}" and everything extracted from it?\n\nEntities left with no evidence are deleted; the rest are marked stale.`
      )
    ) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/sources/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not remove it.");
    } catch (err) {
      setError((err as Error).message);
    }
    void load();
  };

  const active = runs.filter(isActive);
  const failedRuns = runs.filter((r) => r.state === "failed");
  const paused = active.filter((r) => r.state.startsWith("paused"));
  const shelves = SHELF_ORDER.map((shelf) => ({
    shelf,
    items: sources.filter((s) => shelfOf(s) === shelf),
  }));
  // The newest arrivals, whatever shelf they landed on. The shelves group by
  // kind and then by where you are with a book; nothing on the page said when
  // anything arrived, so "what did I add this week" had no answer.
  const recent = [...sources]
    .sort((a, b) => (parseDate(b.added_at)?.getTime() ?? 0) - (parseDate(a.added_at)?.getTime() ?? 0))
    .slice(0, RECENT);

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-semibold">Library</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Everything you add is read and folded into the pedia — a book as you read it, anything
            shorter straight away.
          </p>
        </div>
        <div className="flex items-end gap-6 text-sm">
          {totals && (
            <>
              <Stat label="Entities" value={totals.entities} />
              <Stat label="Passages" value={totals.mentions} />
              <Stat label="Entries" value={totals.entries} />
            </>
          )}
          {active.length > 0 && (
            <a
              href="#activity"
              className="rounded-full border border-[var(--color-rule)] px-3 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
              title="Jump to what the queue is doing"
            >
              {paused.length > 0 ? (
                <span className="text-amber-700">
                  {paused.length} paused
                  {active.length > paused.length ? ` · ${active.length - paused.length} running` : ""}
                </span>
              ) : (
                <span className="text-[var(--color-muted)]">{active.length} running</span>
              )}
            </a>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* The collection. Books, then what you are reading, then what you are */}
      {/* watching — in that order because that is the order you care about.  */}
      {/* ------------------------------------------------------------------ */}

      {!loaded ? (
        <p className="text-sm text-[var(--color-muted)]">Loading…</p>
      ) : sources.length === 0 ? (
        <Empty
          title="Nothing on the shelf yet"
          hint="Add a book, a paper, an article link, or a recording at the bottom of this page."
        />
      ) : (
        <div className="space-y-10">
          {recent.length > 0 && (
            <section>
              <h2 className="mb-3 font-serif text-lg font-semibold">
                Recent
                <span className="ml-2 text-sm font-normal text-[var(--color-muted)]">
                  newest first
                </span>
              </h2>
              <div className="cascade divide-y divide-[var(--color-rule)] rounded-lg border border-[var(--color-rule)] bg-white">
                {recent.map((s) => (
                  <RecentRow key={s.id} s={s} />
                ))}
              </div>
            </section>
          )}

          {shelves.map(({ shelf, items }) => {
            if (items.length === 0) return null;
            return (
              <section key={shelf}>
                <h2 className="mb-3 font-serif text-lg font-semibold">
                  {shelf === "books"
                    ? "Books & documents"
                    : shelf === "reading"
                      ? "Articles & notes"
                      : "Talks & recordings"}
                  <span className="ml-2 text-sm font-normal text-[var(--color-muted)]">
                    {items.length}
                  </span>
                </h2>

                {/* Books are grouped by where you are with them. What you are
                    in the middle of comes first, because that is what you came
                    to the shelf for; what you have finished goes last, because
                    it is the part you are least likely to want. */}
                {shelf === "books" &&
                  READING_STATES.map(({ id, label }) => {
                    const group = items.filter((s) => readingStateOf(s) === id);
                    if (group.length === 0) return null;
                    return (
                      <div key={id} className="mb-7">
                        <h3 className="mb-3 text-xs uppercase tracking-[0.14em] text-[var(--color-muted)]">
                          {label} ({group.length})
                        </h3>
                        <div className="cascade grid grid-cols-3 gap-x-5 gap-y-7 sm:grid-cols-4 lg:grid-cols-6">
                          {group.map((s) => (
                            <BookSpine
                              key={s.id}
                              s={s}
                              onRemove={removeSource}
                              onMove={setReadingState}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}

                {shelf === "reading" && (
                  <Paged items={items} perPage={PER_PAGE}>
                    {(page) => (
                      <div className="cascade divide-y divide-[var(--color-rule)] rounded-lg border border-[var(--color-rule)] bg-white">
                        {page.map((s) => (
                          <ArticleRow key={s.id} s={s} onRemove={removeSource} />
                        ))}
                      </div>
                    )}
                  </Paged>
                )}

                {shelf === "watching" && (
                  <div className="cascade grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
                    {items.map((s) => (
                      <VideoCard key={s.id} s={s} onRemove={removeSource} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Below the fold: housekeeping, the queue, and the way to add more.   */}
      {/* ------------------------------------------------------------------ */}

      <div id="activity" className="space-y-4 border-t border-[var(--color-rule)] pt-8">
        <h2 className="font-serif text-lg font-semibold">Activity</h2>

        {error && <p className="text-sm text-red-700">{error}</p>}

        {stale && stale.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-rule)] bg-white px-4 py-3">
            <p className="text-sm">
              <span className="font-medium">
                {stale.rewrites > 0
                  ? `${stale.rewrites} entr${stale.rewrites === 1 ? "y is" : "ies are"} out of date`
                  : `${stale.newEntries} entit${stale.newEntries === 1 ? "y has" : "ies have"} earned an entry`}
              </span>
              <span className="text-[var(--color-muted)]">
                {stale.rewrites > 0 && stale.newEntries > 0
                  ? `, and ${stale.newEntries} new one${stale.newEntries === 1 ? "" : "s"} to write. `
                  : ". "}
                These are picked up on their own once the queue is clear — this just does it now.
              </span>
            </p>
            <Button
              onClick={async () => {
                await fetch("/api/entries/refresh", { method: "POST" });
                void load();
              }}
            >
              Update now
            </Button>
          </div>
        )}

        {pictures && pictures.pending > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-rule)] bg-white px-4 py-3">
            <p className="text-sm">
              <span className="font-medium">
                {pictures.pending} entr{pictures.pending === 1 ? "y has" : "ies have"} no picture yet
              </span>
              <span className="text-[var(--color-muted)]">
                {" "}
                — {pictures.withPicture} found so far. Looked up on Wikidata, which costs no tokens
                but wants a second and a half between questions, so it runs in the background like
                anything else.
              </span>
            </p>
            <Button
              onClick={async () => {
                await fetch("/api/portraits", { method: "POST" });
                void load();
              }}
            >
              Find pictures
            </Button>
          </div>
        )}

        {paused.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-medium text-amber-900">
              {paused.length === 1 ? "A run is paused" : `${paused.length} runs are paused`}
            </p>
            <p className="mt-1 text-sm text-amber-800">{paused[0].last_error}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {paused.map((r) => (
                <Button key={r.id} onClick={() => act(r.id, "resume")}>
                  Resume &ldquo;{r.label ?? r.source_title ?? `run ${r.id}`}&rdquo;
                </Button>
              ))}
            </div>
          </div>
        )}

        {active.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">The queue is empty.</p>
        ) : (
          active.map((r) => <RunCard key={r.id} run={r} onAct={act} />)
        )}

        {/* Finished badly is still finished: these are not running and offer
            Retry, not Pause. They used to sit in the active list and keep the
            header at "1 running" for ever. */}
        {failedRuns.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-xs uppercase tracking-[0.14em] text-[var(--color-muted)]">
              Finished with errors ({failedRuns.length})
            </h3>
            {failedRuns.map((r) => (
              <RunCard key={r.id} run={r} onAct={act} />
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-[var(--color-rule)] pt-8">
        <h2 className="mb-3 font-serif text-lg font-semibold">Add to the library</h2>
        <AddSource onAdded={load} />
      </div>
    </div>
  );
}

/** How far through you are, drawn as the band along the bottom of a cover. */
function ReadBand({ progress }: { progress: number }) {
  if (progress <= 0.005) return null;
  return (
    <div
      className="absolute inset-x-0 bottom-0 h-1 bg-black/25"
      title={`${Math.round(progress * 100)}% read`}
    >
      <div
        className="h-full bg-[var(--color-accent)]"
        style={{ width: `${Math.min(100, progress * 100)}%` }}
      />
    </div>
  );
}

/**
 * What Corpus has made of a source so far.
 *
 * On a read-along book this is the honest number and it moves as you read: the
 * pedia is built from the passages you have been through, not from the whole
 * file sitting on disk.
 */
function extractionNote(s: SourceRow): string {
  if (s.status === "failed") return "failed";
  if (s.chunks === 0) return s.status;
  if (s.entities > 0 && s.read_chunks >= s.chunks) return `${s.entities} entities`;
  if (s.read_chunks === 0) return s.read_mode === "along" ? "read to index it" : s.status;
  return `${s.entities} entities · ${Math.round((s.read_chunks / s.chunks) * 100)}% indexed`;
}

function BookSpine({
  s,
  onRemove,
  onMove,
}: {
  s: SourceRow;
  onRemove: (id: number, t: string) => void;
  onMove?: (id: number, state: string | null) => void;
}) {
  const progress = s.progress ?? 0;
  const state = readingStateOf(s);
  return (
    <div className="group">
      <Link href={`/sources/${s.id}`} className="block">
        <div className="relative transition-transform duration-200 group-hover:-translate-y-1">
          <SourceCover sourceId={s.id} title={s.title} author={s.author} kind={s.kind} />
          {(s.bookmarks ?? 0) > 0 && (
            <span
              title={`${s.bookmarks} bookmark${s.bookmarks === 1 ? "" : "s"}`}
              className="absolute right-2 top-0 h-6 w-3 rounded-b-sm bg-[var(--color-accent)] shadow"
            />
          )}
          <ReadBand progress={progress} />
        </div>
        <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug group-hover:text-[var(--color-accent)]">
          {s.title}
        </p>
        <p className="truncate text-xs text-[var(--color-muted)]">
          {s.author ?? s.kind.toUpperCase()}
        </p>
      </Link>
      <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-[var(--color-muted)]">
        <span className="truncate">
          {progress > 0.005 ? `${Math.round(progress * 100)}% read` : extractionNote(s)}
        </span>
        <span className="reveal flex shrink-0 gap-2">
          {onMove && (
            <select
              value={s.reading_state ?? ""}
              onChange={(e) => onMove(s.id, e.target.value || null)}
              onClick={(e) => e.stopPropagation()}
              className="max-w-[6.5rem] border-none bg-transparent text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]"
              title={`Currently filed as "${state}". Choose to override, or leave it to follow your progress.`}
            >
              <option value="">Auto</option>
              {READING_STATES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
          <button onClick={() => onRemove(s.id, s.title)} className="hover:text-red-700">
            Remove
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * One line per article.
 *
 * These used to be three-line rows with a book cover turned on its side, which
 * gave a stack of news clippings the same weight on the page as a 600-page
 * book. An article is a thing you skim a list of.
 */
function ArticleRow({ s, onRemove }: { s: SourceRow; onRemove: (id: number, t: string) => void }) {
  const meta = [s.publisher, s.author, s.year].filter(Boolean).join(" · ");
  return (
    <div className="group flex items-center gap-3 px-3 py-2">
      <Link href={`/sources/${s.id}`} className="min-w-0 flex-1 truncate text-sm font-medium hover:text-[var(--color-accent)]">
        {s.title}
      </Link>
      <span className="hidden shrink-0 truncate text-xs text-[var(--color-muted)] sm:block sm:max-w-[16rem]">
        {meta || s.kind.toUpperCase()}
      </span>
      <span
        className="hidden shrink-0 text-xs tabular-nums text-[var(--color-muted)] sm:block"
        title={`Added ${formatDateTime(s.added_at)}`}
      >
        {relativeDate(s.added_at)}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-[var(--color-muted)]">
        {(s.progress ?? 0) > 0.005 ? `${Math.round((s.progress ?? 0) * 100)}%` : extractionNote(s)}
      </span>
      {s.url && (
        <a
          href={s.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]"
          title="Open the original"
        >
          ↗
        </a>
      )}
      <button
        onClick={() => onRemove(s.id, s.title)}
        className="reveal shrink-0 text-xs text-[var(--color-muted)] hover:text-red-700"
        aria-label={`Remove ${s.title}`}
      >
        ✕
      </button>
    </div>
  );
}

/** One arrival, with when it arrived. The shelf it lives on is named too. */
function RecentRow({ s }: { s: SourceRow }) {
  const shelf = shelfOf(s);
  const where =
    shelf === "books" ? "Books & documents" : shelf === "reading" ? "Articles & notes" : "Talks & recordings";
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span
        className="w-24 shrink-0 text-xs tabular-nums text-[var(--color-muted)]"
        title={formatDateTime(s.added_at)}
      >
        {formatDate(s.added_at)}
      </span>
      <Link
        href={`/sources/${s.id}`}
        className="min-w-0 flex-1 truncate text-sm font-medium hover:text-[var(--color-accent)]"
      >
        {s.title}
        {s.author && (
          <span className="ml-2 font-normal text-[var(--color-muted)]">{s.author}</span>
        )}
      </Link>
      <span className="hidden shrink-0 text-xs text-[var(--color-muted)] sm:block">{where}</span>
      <span className="shrink-0 text-xs tabular-nums text-[var(--color-muted)]">
        {(s.progress ?? 0) > 0.005 ? `${Math.round((s.progress ?? 0) * 100)}% read` : extractionNote(s)}
      </span>
    </div>
  );
}

/** A still and a title, the way you would pick a video anywhere else. */
function VideoCard({ s, onRemove }: { s: SourceRow; onRemove: (id: number, t: string) => void }) {
  return (
    <div className="group">
      <Link href={`/sources/${s.id}`} className="block">
        <div className="relative">
          <SourceCover
            sourceId={s.id}
            title={s.title}
            author={s.author}
            kind={s.kind}
            ratio="video"
          />
          <ReadBand progress={s.progress ?? 0} />
        </div>
        <p className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug group-hover:text-[var(--color-accent)]">
          {s.title}
        </p>
      </Link>
      <div className="flex items-center justify-between gap-2 text-xs text-[var(--color-muted)]">
        <span className="truncate">{s.author ?? extractionNote(s)}</span>
        <button
          onClick={() => onRemove(s.id, s.title)}
          className="reveal shrink-0 hover:text-red-700"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "amber" }) {
  return (
    <div>
      <div className={`font-serif text-xl font-semibold ${tone === "amber" ? "text-amber-600" : ""}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-[var(--color-muted)]">{label}</div>
    </div>
  );
}

function RunCard({
  run,
  onAct,
}: {
  run: Run;
  onAct: (id: number, action: string, budgetCap?: number) => void;
}) {
  const label = STATE_LABEL[run.state] ?? { text: run.state, tone: "quiet" as const };
  const isPaused = run.state.startsWith("paused");
  const isFailed = run.state === "failed";
  const tokens = run.tokens_in + run.tokens_out;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">
              {run.label ?? run.source_title ?? `Run ${run.id}`}
            </span>
            <Badge tone={label.tone}>{label.text}</Badge>
          </div>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {run.done} of {run.total} steps
            {run.failed > 0 && ` · ${run.failed} failed`}
            {tokens > 0 && ` · ${tokens.toLocaleString()} tokens`}
            {run.budget_cap ? ` of ${run.budget_cap.toLocaleString()}` : ""}
            {run.models && (
              <>
                {" · "}
                <Badge>{run.models}</Badge>
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {isFailed ? (
            <Button variant="primary" onClick={() => onAct(run.id, "retry")}>
              Retry{run.failed > 0 ? ` ${run.failed} failed` : ""}
            </Button>
          ) : isPaused ? (
            <Button variant="primary" onClick={() => onAct(run.id, "resume")}>
              Resume
            </Button>
          ) : (
            <Button onClick={() => onAct(run.id, "pause")}>Pause</Button>
          )}
          {!isFailed && run.failed > 0 && (
            <Button onClick={() => onAct(run.id, "retry")}>Retry {run.failed} failed</Button>
          )}
          {run.state === "paused_budget" && (
            <Button
              onClick={() => {
                const next = prompt(
                  "New token cap for this run (blank = no cap):",
                  String((run.budget_cap ?? 0) * 2)
                );
                if (next !== null) onAct(run.id, "budget", Number(next) || 0);
              }}
            >
              Raise cap
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3">
        <Progress value={run.done} total={run.total} tone={isPaused || isFailed ? "amber" : "accent"} />
      </div>

      {run.last_error && <p className="mt-2 text-sm text-[var(--color-muted)]">{run.last_error}</p>}
      {run.resume_at && !isFailed && (
        <p className="mt-1 text-sm text-amber-700">
          Will retry on its own {relativeDate(run.resume_at)} ({formatDateTime(run.resume_at)}).
        </p>
      )}
    </Card>
  );
}
