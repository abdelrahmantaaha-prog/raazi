"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, Empty, Progress } from "./components/ui";
import { AddSource } from "./components/AddSource";
import { SourceCover } from "./components/SourceCover";
import { READING_STATES, readingStateOf, shelfOf } from "@/lib/shelves";

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
    } finally {
      setLoaded(true);
    }
  }, [loadBadges]);

  // Poll while anything is moving; back off to a slow tick when it isn't. The
  // busy flag is a ref rather than state because the effect runs once and would
  // otherwise close over the empty first render for ever — which it did, so the
  // page polled every eight seconds even mid-ingest.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await load();
      timer.current = setTimeout(tick, busyRef.current ? 1500 : 8000);
    };
    void tick();
    void loadBadges();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, loadBadges]);

  const act = async (runId: number, action: string, budgetCap?: number) => {
    await fetch(`/api/runs/${runId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, budgetCap }),
    });
    void load();
  };

  const setReadingState = async (id: number, readingState: string | null) => {
    // Optimistic: the shelf regroups as you choose, rather than after a round trip.
    setSources((rows) =>
      rows.map((r) => (r.id === id ? { ...r, reading_state: readingState } : r))
    );
    await fetch(`/api/sources/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ readingState }),
    });
  };

  const removeSource = async (id: number, title: string) => {
    if (
      !confirm(
        `Remove "${title}" and everything extracted from it?\n\nEntities left with no evidence are deleted; the rest are marked stale.`
      )
    ) {
      return;
    }
    await fetch(`/api/sources/${id}`, { method: "DELETE" });
    void load();
  };

  const active = runs.filter((r) => r.state !== "done");
  const paused = active.filter((r) => r.state.startsWith("paused"));
  const shelves = SHELF_ORDER.map((shelf) => ({
    shelf,
    items: sources.filter((s) => shelfOf(s) === shelf),
  }));

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
              <Stat label="Quotes" value={totals.mentions} />
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
                  <div className="cascade divide-y divide-[var(--color-rule)] rounded-lg border border-[var(--color-rule)] bg-white">
                    {items.map((s) => (
                      <ArticleRow key={s.id} s={s} onRemove={removeSource} />
                    ))}
                  </div>
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
        <span className="flex shrink-0 gap-2 opacity-0 transition group-hover:opacity-100">
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
        className="shrink-0 text-xs text-[var(--color-muted)] opacity-0 transition group-hover:opacity-100 hover:text-red-700"
      >
        ✕
      </button>
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
          className="shrink-0 opacity-0 transition group-hover:opacity-100 hover:text-red-700"
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
          </p>
        </div>
        <div className="flex gap-2">
          {isPaused ? (
            <Button variant="primary" onClick={() => onAct(run.id, "resume")}>
              Resume
            </Button>
          ) : (
            <Button onClick={() => onAct(run.id, "pause")}>Pause</Button>
          )}
          {run.failed > 0 && (
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
        <Progress value={run.done} total={run.total} tone={isPaused ? "amber" : "accent"} />
      </div>

      {run.last_error && <p className="mt-2 text-sm text-[var(--color-muted)]">{run.last_error}</p>}
      {run.resume_at && (
        <p className="mt-1 text-sm text-amber-700">
          Will retry on its own after {new Date(run.resume_at).toLocaleString()}.
        </p>
      )}
    </Card>
  );
}
