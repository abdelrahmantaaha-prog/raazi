"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "./ui";

interface RunState {
  id: number;
  state: string;
  label?: string | null;
  total?: number;
  done?: number;
  failed?: number;
  last_error?: string | null;
  /** Which model(s) answered so far, comma-separated. */
  models?: string | null;
}

const LABEL: Record<string, { text: string; tone: "running" | "warn" | "danger" | "ok" | "quiet" }> = {
  queued: { text: "Queued", tone: "quiet" },
  running: { text: "Running", tone: "running" },
  paused_quota: { text: "Out of quota", tone: "warn" },
  paused_user: { text: "Paused", tone: "quiet" },
  paused_budget: { text: "Budget spent", tone: "warn" },
  paused_key: { text: "Key problem", tone: "danger" },
  done: { text: "Done", tone: "ok" },
  failed: { text: "Finished with errors", tone: "danger" },
};

/** States the chip stops watching at. A paused run is not going to finish on its own. */
const SETTLED = new Set(["done", "failed", "paused_user", "paused_budget", "paused_key"]);

/**
 * What became of the run a button just started.
 *
 * "Will appear here shortly" was the whole of the feedback after Generate,
 * Enhance, Read again and Restore context, and it never updated — the page had
 * no idea whether the run was queued, halfway, out of quota or finished. This
 * asks every five seconds until it is settled, then refreshes the page so the
 * result is on it.
 *
 * Tolerant of both shapes the run endpoint may answer with: `{ run }` and a
 * 404 for an id it does not know.
 */
export function RunChip({
  runId,
  onDone,
  className = "",
}: {
  runId: number | null | undefined;
  /** Called once when the run finishes. Defaults to refreshing the page. */
  onDone?: () => void;
  className?: string;
}) {
  const router = useRouter();
  const [run, setRun] = useState<RunState | null>(null);
  const [gone, setGone] = useState(false);
  const finished = useRef<number | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setRun(null);
    setGone(false);

    const tick = async () => {
      if (cancelled) return;
      if (document.hidden) {
        timer = setTimeout(tick, 5000);
        return;
      }
      try {
        const res = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
        if (res.status === 404) {
          if (!cancelled) setGone(true);
          return;
        }
        const data = (await res.json()) as { run?: RunState | null };
        if (cancelled) return;
        const r = data.run ?? null;
        if (!r) {
          setGone(true);
          return;
        }
        setRun(r);
        if (SETTLED.has(r.state)) {
          if (r.state === "done" && finished.current !== runId) {
            finished.current = runId;
            if (onDoneRef.current) onDoneRef.current();
            else router.refresh();
          }
          return;
        }
      } catch {
        // A dropped request is not a verdict; ask again next tick.
      }
      timer = setTimeout(tick, 5000);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, router]);

  if (!runId) return null;

  if (gone) {
    return (
      <span className={`inline-flex items-center gap-2 text-xs text-[var(--color-muted)] ${className}`}>
        <Badge tone="quiet">Run {runId}</Badge> no longer listed.
      </span>
    );
  }

  const label = run ? LABEL[run.state] ?? { text: run.state, tone: "quiet" as const } : null;
  const total = run?.total ?? 0;

  return (
    <span className={`inline-flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)] ${className}`}>
      {label ? <Badge tone={label.tone}>{label.text}</Badge> : <Badge tone="quiet">Starting…</Badge>}
      {run && total > 0 && (
        <span className="tabular-nums">
          {run.done ?? 0} of {total} step{total === 1 ? "" : "s"}
          {(run.failed ?? 0) > 0 ? ` · ${run.failed} failed` : ""}
        </span>
      )}
      {run?.models && <Badge>{run.models}</Badge>}
      {run?.last_error && SETTLED.has(run.state) && run.state !== "done" && (
        <span className="max-w-[24rem] truncate" title={run.last_error}>
          {run.last_error}
        </span>
      )}
      <Link href="/#activity" className="hover:text-[var(--color-accent)] hover:underline">
        Activity
      </Link>
    </span>
  );
}
