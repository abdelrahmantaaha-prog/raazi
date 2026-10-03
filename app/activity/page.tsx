"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Progress } from "../components/ui";
import { formatDateTime, relativeDate } from "@/lib/dates";

interface Run {
  id: number;
  kind: string;
  label: string | null;
  state: string;
  source_id: number | null;
  source_title: string | null;
  resume_at: string | null;
  tokens_in: number;
  tokens_out: number;
  budget_cap: number | null;
  last_error: string | null;
  updated_at: string;
  /** You marked it "Do this first". */
  first: number;
  total: number;
  done: number;
  failed: number;
  pending: number;
  /** Which model(s) answered, comma-separated; null until one has. */
  models: string | null;
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

/** A run still has somewhere to go. Failed runs are finished, just badly. */
const isActive = (r: Run) => r.state !== "done" && r.state !== "failed";

/** How many finished runs the page lists under the queue. */
const RECENT_DONE = 15;

/**
 * Activity: what the background worker is doing, what is waiting, and what
 * went wrong.
 *
 * It lived at the bottom of the Library, below every shelf, so seeing whether
 * anything was moving meant scrolling past the whole collection. It is a page
 * of its own now. The Library keeps a small "running" count that leads here.
 *
 * The queue works on one task at a time. The brief and the news fetching go
 * first, then reading, and writing entries last, because an entry takes
 * minutes and can wait without anyone noticing.
 */
export default function ActivityPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [stale, setStale] = useState<StaleInfo | null>(null);
  const [pictures, setPictures] = useState<{ entries: number; withPicture: number; checked: number; pending: number } | null>(
    null
  );
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);

  // The out-of-date entries and missing pictures are the two most expensive
  // reads in the app, and they only change when work finishes — so they are
  // asked for on arrival, when the queue goes quiet, and after their buttons.
  const loadBadges = useCallback(async () => {
    try {
      setStale(await (await fetch("/api/entries/refresh", { cache: "no-store" })).json());
      setPictures(await (await fetch("/api/portraits", { cache: "no-store" })).json());
    } catch {
      // Keep the last numbers.
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/runs?only=runs", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setRuns(data.runs ?? []);
      const busy = (data.runs ?? []).some((r: Run) => r.state === "running" || r.state === "queued");
      if (busyRef.current && !busy) void loadBadges();
      busyRef.current = busy;
    } catch {
      // A restart or a laptop waking drops one request; the next tick asks again.
    } finally {
      setLoaded(true);
    }
  }, [loadBadges]);

  // Quick while anything is moving, slow when it is not, and nothing at all
  // while the tab is hidden.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (cancelled || inFlight || document.hidden) return;
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

  // Oldest first: within its place in the order, the queue takes the batch
  // that has waited longest.
  const active = runs.filter(isActive).sort((a, b) => a.id - b.id);
  const paused = active.filter((r) => r.state.startsWith("paused"));
  const waiting = active.reduce((n, r) => n + r.pending, 0);
  const failedRuns = runs.filter((r) => r.state === "failed");
  const finished = runs.filter((r) => r.state === "done").slice(0, RECENT_DONE);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Activity</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          What Corpus is working on in the background. It does one step at a time: the brief and
          the news first, then reading what you add, and writing entries last, since an entry takes
          a few minutes and can wait. “Do this first” moves a batch’s reading ahead of the rest.
          {active.length > 0 && (
            <>
              {" "}
              <span className="font-medium text-[var(--color-ink)]">
                {active.length} batch{active.length === 1 ? "" : "es"}, {waiting.toLocaleString()} step
                {waiting === 1 ? "" : "s"} waiting.
              </span>
            </>
          )}
        </p>
      </div>

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
              void loadBadges();
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
              — {pictures.withPicture} found so far. Looked up on Wikidata, which costs no tokens but
              wants a second and a half between questions, so it runs in the background like anything
              else.
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
            {paused.length === 1 ? "A batch is paused" : `${paused.length} batches are paused`}
          </p>
          <p className="mt-1 text-sm text-amber-800">{paused[0].last_error}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {paused.map((r) => (
              <Button key={r.id} onClick={() => act(r.id, "resume")}>
                Resume &ldquo;{r.label ?? r.source_title ?? `batch ${r.id}`}&rdquo;
              </Button>
            ))}
          </div>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="font-serif text-lg font-semibold">In the queue</h2>
        {!loaded ? (
          <p className="text-sm text-[var(--color-muted)]">Loading…</p>
        ) : active.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">The queue is empty.</p>
        ) : (
          active.map((r) => <RunCard key={r.id} run={r} onAct={act} />)
        )}
      </section>

      {/* Finished badly is still finished: these offer Retry, not Pause. */}
      {failedRuns.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-serif text-lg font-semibold">
            Finished with errors <span className="text-sm font-normal text-[var(--color-muted)]">{failedRuns.length}</span>
          </h2>
          {failedRuns.map((r) => (
            <RunCard key={r.id} run={r} onAct={act} />
          ))}
        </section>
      )}

      {finished.length > 0 && (
        <section>
          <h2 className="mb-3 font-serif text-lg font-semibold">Recently finished</h2>
          <ul className="divide-y divide-[var(--color-rule)] rounded-lg border border-[var(--color-rule)] bg-white">
            {finished.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate" dir="auto">
                  {r.label ?? r.source_title ?? `Batch ${r.id}`}
                </span>
                <span className="text-xs text-[var(--color-muted)]">
                  {r.total} step{r.total === 1 ? "" : "s"}
                  {r.models ? ` · ${r.models}` : ""}
                </span>
                <span className="text-xs text-[var(--color-muted)]" title={formatDateTime(r.updated_at)}>
                  {relativeDate(r.updated_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function RunCard({ run, onAct }: { run: Run; onAct: (id: number, action: string, budgetCap?: number) => void }) {
  const label = STATE_LABEL[run.state] ?? { text: run.state, tone: "quiet" as const };
  const isPaused = run.state.startsWith("paused");
  const isFailed = run.state === "failed";
  const tokens = run.tokens_in + run.tokens_out;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium" dir="auto">
              {run.label ?? run.source_title ?? `Batch ${run.id}`}
            </span>
            <Badge tone={label.tone}>{label.text}</Badge>
            {run.first && !isFailed ? <Badge tone="running">first</Badge> : null}
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
            <>
              {run.first ? (
                <Button onClick={() => onAct(run.id, "unfirst")}>Back in line</Button>
              ) : (
                <Button onClick={() => onAct(run.id, "first")}>Do this first</Button>
              )}
              <Button onClick={() => onAct(run.id, "pause")}>Pause</Button>
            </>
          )}
          {!isFailed && run.failed > 0 && <Button onClick={() => onAct(run.id, "retry")}>Retry {run.failed} failed</Button>}
          {run.state === "paused_budget" && (
            <Button
              onClick={() => {
                const next = prompt("New token cap for this batch (blank = no cap):", String((run.budget_cap ?? 0) * 2));
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
