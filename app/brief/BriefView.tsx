"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EntryBody, type Citation } from "../components/EntryBody";
import { CitationPopover } from "../components/CitationPopover";
import { RunChip } from "../components/RunChip";
import { Badge } from "../components/ui";
import { formatDate, formatDateTime } from "@/lib/dates";
import type { CalendarRow } from "@/lib/calendar";
import { IconCalendar } from "../components/Icons";

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
  calendar,
}: {
  today: string;
  brief: {
    day: string;
    body: string;
    state: string;
    from: string | null;
    to: string | null;
    error: string | null;
    model: string | null;
  } | null;
  days: { day: string; state: string }[];
  citations: BriefCitation[];
  watchlist: { id: number; label: string; kind: string; entityId: number | null; recent: number }[];
  stats: Record<string, number>;
  /** The dates this brief noticed, for the block under it. */
  calendar?: CalendarRow[];
}) {
  const router = useRouter();
  const [openCite, setOpenCite] = useState<{ id: number; anchor: HTMLElement } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);

  const citationMap = useMemo(() => new Map(citations.map((c) => [c.id, c])), [citations]);
  const open = openCite ? citationMap.get(openCite.id) : undefined;

  /**
   * Writes a brief for a named day.
   *
   * The day is a parameter and not `brief?.day` because of what that cost: the
   * page opens on the newest brief there is, which after a quiet few days is an
   * old one, and the button then rewrote *that* — you pressed it expecting
   * today and got the fourth rewritten again. Which day is being written is now
   * the caller's decision and the label's promise.
   */
  async function write(force: boolean, day: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ day, force }),
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

  /** What is on screen is today's, and it has been written. */
  const todayIsWritten = brief?.day === today && brief.state === "done";
  /** What is on screen is an older brief, because today has none yet. */
  const stale = Boolean(brief && brief.day !== today);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-semibold">
            {brief ? (brief.day === today ? "Today" : formatDate(brief.day)) : "The brief"}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {stale
              ? `No brief for today yet — this is the last one written. The daily brief waits for an empty inbox.`
              : brief?.from && brief.to
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
            onClick={() => write(todayIsWritten, today)}
            disabled={busy}
            className="rounded border border-[var(--color-rule)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)] disabled:opacity-50"
          >
            {busy ? "Asking…" : todayIsWritten ? "Write today's again" : "Write today's brief"}
          </button>
          {stale && brief ? (
            <button
              type="button"
              onClick={() => write(true, brief.day)}
              disabled={busy}
              className="rounded border border-[var(--color-rule)] px-3 py-1.5 text-sm text-[var(--color-muted)] hover:border-[var(--color-accent)] disabled:opacity-50"
            >
              Rewrite {formatDate(brief.day)}
            </button>
          ) : null}
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

          <BriefCalendar rows={calendar ?? []} />

          {Object.keys(stats).length || brief.model ? (
            <p className="text-xs text-[var(--color-muted)]">
              {Object.keys(stats).length ? (
                <>
                  {stats.sources ?? 0} source(s), {stats.passages ?? 0} passage(s), {stats.entities ?? 0} subject(s)
                  {stats.stories ? `, ${stats.stories} new story` : ""} in this window.
                </>
              ) : null}
              {brief.model ? (
                <>
                  {" "}
                  Written by <Badge>{brief.model}</Badge>.
                </>
              ) : null}
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

/**
 * The dates the brief's sources mentioned, under the prose rather than in it.
 *
 * Kept out of the model's hands on purpose: a date is the one thing in a
 * brief a reporter acts on without re-reading the article, so it is drawn
 * from the events table directly and every line opens the entity and the
 * passage. Days the sources fixed come first; what they placed only within a
 * week, a month or a year is piled under "Sometime in".
 */
function BriefCalendar({ rows }: { rows: CalendarRow[] }) {
  if (!rows.length) return null;
  const days = rows.filter((r) => r.kind === "day");
  const vague = rows.filter((r) => r.kind !== "day");
  const groups = new Map<string, CalendarRow[]>();
  for (const r of vague) {
    const list = groups.get(r.label) ?? [];
    list.push(r);
    groups.set(r.label, list);
  }
  const upcoming = days.filter((r) => r.tense !== "past");
  const past = days.filter((r) => r.tense === "past");

  const line = (r: CalendarRow) => (
    <li key={r.id} className="flex gap-2 text-sm">
      <span className="min-w-0 flex-1">
        {r.summary}{" "}
        <Link href={`/pedia/${r.entity_id}`} className="text-xs text-[var(--color-accent)] hover:underline">
          {r.entity}
        </Link>
        {r.source_id ? (
          <>
            {" "}
            <Link
              href={`/sources/${r.source_id}${r.chunk_id ? `?chunk=${r.chunk_id}` : ""}`}
              className="text-xs text-[var(--color-muted)] hover:underline"
            >
              {r.outlet ?? r.source_title ?? "source"}
            </Link>
          </>
        ) : null}
      </span>
    </li>
  );

  const dayGroups = (list: CalendarRow[]) => {
    const byDay = new Map<string, CalendarRow[]>();
    for (const r of list) byDay.set(r.bucket, [...(byDay.get(r.bucket) ?? []), r]);
    return [...byDay.entries()].map(([day, items]) => (
      <div key={day}>
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">{formatDate(day)}</p>
        <ul className="mt-1 space-y-1">{items.map(line)}</ul>
      </div>
    ));
  };

  return (
    <section className="max-w-[70ch] rounded-xl border border-[var(--color-rule)] p-4">
      <div className="flex items-baseline gap-3">
        <h2 className="flex items-center gap-2 font-serif text-lg font-semibold">
          <IconCalendar className="text-[var(--color-accent)]" /> Watching calendar
        </h2>
        <Link href="/calendar" className="ml-auto text-xs text-[var(--color-accent)] hover:underline">
          The whole calendar
        </Link>
      </div>
      <div className="mt-3 space-y-4">
        {upcoming.length ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">Coming up</p>
            {dayGroups(upcoming)}
          </div>
        ) : null}
        {groups.size ? (
          <div className="space-y-3">
            {[...groups.entries()].map(([label, items]) => (
              <div key={label}>
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">{label}</p>
                <ul className="mt-1 space-y-1">{items.map(line)}</ul>
              </div>
            ))}
          </div>
        ) : null}
        {past.length ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">Already happened</p>
            {dayGroups(past)}
          </div>
        ) : null}
      </div>
    </section>
  );
}
