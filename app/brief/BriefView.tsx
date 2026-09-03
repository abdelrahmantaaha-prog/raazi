"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EntryBody, type Citation } from "../components/EntryBody";
import { CitationPopover } from "../components/CitationPopover";
import { RunChip } from "../components/RunChip";
import { formatDate, formatDateTime } from "@/lib/dates";

interface BriefCitation extends Citation {
  chunkId: number | null;
  entityId: number;
  entityName: string;
  outlet: string | null;
  publishedAt: string | null;
  url: string | null;
}

/**
 * The brief, and the two things that make it different from a newsletter:
 * every line opens the passage it rests on, and the window it covers is
 * stated. If a claim in here cannot be checked in one click, that is a bug.
 */
export function BriefView({
  today,
  brief,
  days,
  citations,
  watchlist,
  stats,
}: {
  today: string;
  brief: { day: string; body: string; state: string; from: string | null; to: string | null; error: string | null } | null;
  days: { day: string; state: string }[];
  citations: BriefCitation[];
  watchlist: { id: number; label: string; kind: string; entityId: number | null; recent: number }[];
  stats: Record<string, number>;
}) {
  const router = useRouter();
  const [openCite, setOpenCite] = useState<{ id: number; anchor: HTMLElement } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);

  const citationMap = useMemo(() => new Map(citations.map((c) => [c.id, c])), [citations]);
  const open = openCite ? citationMap.get(openCite.id) : undefined;

  async function write(force: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ day: brief?.day ?? today, force }),
      });
      const data = (await res.json().catch(() => ({}))) as { runId?: number; note?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "That did not work.");
      if (data.runId) setRunId(data.runId);
      else if (data.note) setError(data.note);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const isToday = !brief || brief.day === today;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-semibold">
            {brief ? (brief.day === today ? "Today" : formatDate(brief.day)) : "The brief"}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {brief?.from && brief.to
              ? `What came in between ${formatDateTime(brief.from)} and ${formatDateTime(brief.to)}.`
              : "What came in from the feeds you follow, with a citation on every line."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {runId ? (
            <RunChip runId={runId} onDone={() => { setRunId(null); router.refresh(); }} />
          ) : null}
          <button
            type="button"
            onClick={() => write(Boolean(brief && brief.state === "done"))}
            disabled={busy}
            className="rounded border border-[var(--color-rule)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)] disabled:opacity-50"
          >
            {busy ? "Asking…" : brief?.state === "done" ? "Write it again" : isToday ? "Write today's brief" : "Write this brief"}
          </button>
          <Link
            href="/feeds"
            className="rounded border border-[var(--color-rule)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)]"
          >
            Feeds
          </Link>
        </div>
      </header>

      {error ? (
        <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>
      ) : null}

      {watchlist.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-[var(--color-muted)]">Watching:</span>
          {watchlist.map((w) => (
            <span key={w.id} className="inline-flex items-center gap-1 rounded-full border border-[var(--color-rule)] px-2 py-0.5">
              {w.entityId ? (
                <Link href={`/pedia/${w.entityId}`} className="hover:text-[var(--color-accent)]">
                  {w.label}
                </Link>
              ) : (
                w.label
              )}
              {w.recent > 0 ? (
                <span className="rounded-full bg-[var(--color-accent-soft)] px-1.5 text-xs text-[var(--color-accent)]">
                  {w.recent}
                </span>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <p className="rounded border border-dashed border-[var(--color-rule)] px-3 py-2 text-sm text-[var(--color-muted)]">
          Nothing on your watchlist yet. Star a person or an institution in the pedia, or a topic, and the brief
          will lead with them.
        </p>
      )}

      {brief && brief.state === "done" && brief.body ? (
        <>
          <article className="max-w-[70ch]">
            <EntryBody
              body={brief.body}
              citations={citationMap}
              onCite={(id, anchor) => setOpenCite((cur) => (cur?.id === id ? null : { id, anchor }))}
              activeId={openCite?.id}
            />
          </article>

          {open ? (
            <CitationPopover
              citation={open}
              anchor={openCite?.anchor ?? null}
              onClose={() => setOpenCite(null)}
              onShowInEvidence={(id) => {
                const c = citationMap.get(id);
                if (c) router.push(`/pedia/${c.entityId}?tab=evidence`);
              }}
            />
          ) : null}

          {Object.keys(stats).length ? (
            <p className="text-xs text-[var(--color-muted)]">
              {stats.sources ?? 0} source(s), {stats.passages ?? 0} passage(s), {stats.entities ?? 0} subject(s)
              {stats.stories ? `, ${stats.stories} new story` : ""} in this window.
            </p>
          ) : null}
        </>
      ) : brief && brief.state === "pending" ? (
        <p className="text-sm text-[var(--color-muted)]">Being written now. It will appear here.</p>
      ) : brief && brief.state === "failed" ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {brief.error ?? "The brief could not be written."}
        </p>
      ) : (
        <p className="rounded border border-dashed border-[var(--color-rule)] px-4 py-6 text-sm text-[var(--color-muted)]">
          No brief yet. Add a feed or two, then write one — it is built from what your library took in, so it
          needs something to have arrived first.
        </p>
      )}

      {days.length > 1 ? (
        <nav className="flex flex-wrap gap-2 border-t border-[var(--color-rule)] pt-4 text-sm">
          <span className="text-[var(--color-muted)]">Earlier:</span>
          {days.map((d) => (
            <Link
              key={d.day}
              href={`/brief?day=${d.day}`}
              className={`rounded px-2 py-0.5 hover:bg-[var(--color-accent-soft)] ${
                brief?.day === d.day ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : ""
              }`}
            >
              {d.day === today ? "today" : formatDate(d.day)}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
