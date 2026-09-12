"use client";

import { useState } from "react";
import Link from "next/link";
import type { CalendarRow, CalendarSections } from "@/lib/calendar";
import { formatDate } from "@/lib/dates";
import { IconCalendar, IconDismiss, IconSync } from "../components/Icons";

/**
 * Three shapes, in the order a reporter needs them: what is coming, what is
 * only roughly placed, and what has been. A line is a fact about a date,
 * not a summary of a story — its entity and its source are one click away,
 * and "dismiss" is for the dates that are somebody else's to watch.
 */
export function CalendarView({ initial }: { initial: CalendarSections }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/calendar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as CalendarSections & { error?: string; added?: number };
      if (!res.ok) throw new Error(json.error ?? "That did not work.");
      setData(json);
      if (typeof json.added === "number") {
        setNote(json.added === 0 ? "Nothing new to file — every date in that window is already here." : `${json.added} date${json.added === 1 ? "" : "s"} filed.`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const empty = !data.upcoming.length && !data.sometime.length && !data.past.length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-3xl font-semibold">
            <IconCalendar size={26} className="text-[var(--color-accent)]" />
            Watching calendar
          </h1>
          <p className="mt-1 max-w-[62ch] text-sm text-[var(--color-muted)]">
            Every date the sources mention — elections, rulings, anniversaries, deadlines — filed as
            precisely as the source allowed. A day the source named is a day; anything vaguer sits
            under the week, month or year it belongs to.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => post({ action: "refresh", days: 30 })}
            title="File every date in the sources of the last thirty days"
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-rule)] px-3 py-1.5 text-sm transition hover:border-[var(--color-accent)] disabled:opacity-40"
          >
            <IconSync /> File the last 30 days
          </button>
          <Link
            href="/brief"
            className="rounded-full border border-[var(--color-rule)] px-3 py-1.5 text-sm transition hover:border-[var(--color-accent)]"
          >
            Today&apos;s brief
          </Link>
        </div>
      </header>

      {error ? (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>
      ) : null}
      {note ? <p className="text-sm text-[var(--color-muted)]">{note}</p> : null}

      {empty ? (
        <div className="rounded-xl border border-dashed border-[var(--color-rule)] px-6 py-16 text-center">
          <p className="font-serif text-xl">Nothing on the calendar yet</p>
          <p className="mx-auto mt-2 max-w-[48ch] text-sm text-[var(--color-muted)]">
            Dates are filed each time a brief is prepared. To fill it from what is already in the
            library, file the last thirty days.
          </p>
        </div>
      ) : null}

      {data.upcoming.length ? (
        <Section title="Coming up" hint="Days the sources fixed exactly, soonest first. Today counts.">
          <DayList rows={data.upcoming} busy={busy} onDismiss={(id) => post({ action: "dismiss", id })} />
        </Section>
      ) : null}

      {data.sometime.length ? (
        <Section title="Sometime in…" hint="What the sources placed only within a week, a month or a year. Future first.">
          <div className="space-y-4">
            {data.sometime.map((g) => (
              <div key={`${g.kind}:${g.bucket}`} className="rounded-xl border border-[var(--color-rule)]">
                <div className="flex items-center gap-2 border-b border-[var(--color-rule)] bg-[var(--color-accent-soft)]/30 px-4 py-2">
                  <span className="font-medium">{g.label}</span>
                  <Tense tense={g.tense} />
                  <span className="ml-auto text-xs text-[var(--color-muted)]">
                    {g.items.length} {g.items.length === 1 ? "line" : "lines"}
                  </span>
                </div>
                <ul className="divide-y divide-[var(--color-rule)]">
                  {g.items.map((r) => (
                    <Line key={r.id} row={r} busy={busy} onDismiss={(id) => post({ action: "dismiss", id })} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {data.past.length ? (
        <Section
          title="Already happened"
          hint="Days that have passed, most recent first — the anniversaries and the things that were 'due'."
          action={
            <button
              type="button"
              onClick={() => setShowPast((v) => !v)}
              className="text-xs text-[var(--color-accent)] hover:underline"
            >
              {showPast ? "Hide" : `Show ${data.past.length}`}
            </button>
          }
        >
          {showPast ? (
            <DayList rows={data.past} busy={busy} onDismiss={(id) => post({ action: "dismiss", id })} />
          ) : null}
        </Section>
      ) : null}

      {data.counts.dismissed > 0 ? (
        <p className="text-xs text-[var(--color-muted)]">
          {data.counts.dismissed} dismissed line{data.counts.dismissed === 1 ? "" : "s"} not shown.
        </p>
      ) : null}
    </div>
  );
}

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="font-serif text-xl font-semibold">{title}</h2>
        <p className="text-sm text-[var(--color-muted)]">{hint}</p>
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Tense({ tense }: { tense: CalendarRow["tense"] }) {
  if (tense === "current") {
    return <span className="rounded-full bg-[var(--color-accent)] px-2 py-0.5 text-[11px] font-medium text-white">now</span>;
  }
  if (tense === "upcoming") {
    return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800">ahead</span>;
  }
  return <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600">past</span>;
}

/** Exact days, grouped by the day so five sources on one election read as one heading. */
function DayList({ rows, busy, onDismiss }: { rows: CalendarRow[]; busy: boolean; onDismiss: (id: number) => void }) {
  const byDay = new Map<string, CalendarRow[]>();
  for (const r of rows) {
    const list = byDay.get(r.bucket) ?? [];
    list.push(r);
    byDay.set(r.bucket, list);
  }
  return (
    <div className="space-y-3">
      {[...byDay.entries()].map(([day, items]) => (
        <div key={day} className="rounded-xl border border-[var(--color-rule)]">
          <div className="flex items-center gap-2 border-b border-[var(--color-rule)] bg-[var(--color-accent-soft)]/30 px-4 py-2">
            <span className="font-medium">{formatDate(day)}</span>
            <span className="text-xs text-[var(--color-muted)]">
              {new Date(`${day}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long" })}
            </span>
            <Tense tense={items[0].tense} />
          </div>
          <ul className="divide-y divide-[var(--color-rule)]">
            {items.map((r) => (
              <Line key={r.id} row={r} busy={busy} onDismiss={onDismiss} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Line({ row, busy, onDismiss }: { row: CalendarRow; busy: boolean; onDismiss: (id: number) => void }) {
  return (
    <li className="group flex gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">{row.summary}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-[var(--color-muted)]">
          <Link href={`/pedia/${row.entity_id}`} className="font-medium text-[var(--color-accent)] hover:underline">
            {row.entity}
          </Link>
          {row.date_text ? <span className="italic">“{row.date_text}”</span> : null}
          {row.source_id ? (
            <Link
              href={`/sources/${row.source_id}${row.chunk_id ? `?chunk=${row.chunk_id}` : ""}`}
              className="hover:text-[var(--color-accent)] hover:underline"
              title={row.source_title ?? undefined}
            >
              {row.outlet ?? row.source_title ?? "source"}
            </Link>
          ) : null}
        </p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => onDismiss(row.id)}
        title="Not one to watch"
        aria-label="Dismiss"
        className="reveal shrink-0 self-start rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-ink)] disabled:opacity-40"
      >
        <IconDismiss />
      </button>
    </li>
  );
}
