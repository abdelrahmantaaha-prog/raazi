"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { CalendarGroup, CalendarRow, CalendarSections } from "@/lib/calendar";
import { AlsoSources } from "../components/AlsoSources";
import { formatDate } from "@/lib/dates";
import { IconCalendar, IconDismiss, IconSync } from "../components/Icons";

/**
 * The watching calendar, as a calendar.
 *
 * A month grid is the shape a reporter already reads dates in, and the shape
 * that makes an absence visible: an empty Tuesday between two crowded days is
 * information a list never shows. Each day carries what the sources placed on
 * it; today is marked; a day opens to its lines beneath the grid; and a Next
 * up list beside it runs through what is ahead without paging months.
 *
 * Two kinds of line sit on a day. A **dated** one the source fixed to that
 * day in that year. An **anniversary** is a day the source named without a
 * year for something already done — "the Oct. 7 attack" — which the calendar
 * therefore shows on the day's next occurrence, marked as recurring, rather
 * than pretending to know a year it was never given. What the sources placed
 * only within a week, a month or a year cannot sit on a day, so it is listed
 * under the grid for the month in view, and in full further down.
 */

type Cursor = { y: number; m: number }; // m is 0-based

const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => keyOf(new Date());
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The next YYYY-MM-DD on which an MM-DD falls, today included. */
function nextOn(mmdd: string, now = new Date()): string {
  const [m, d] = mmdd.split("-").map(Number);
  const thisYear = new Date(now.getFullYear(), m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return keyOf(thisYear >= today ? thisYear : new Date(now.getFullYear() + 1, m - 1, d));
}

export function CalendarView({ initial }: { initial: CalendarSections }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [cursor, setCursor] = useState<Cursor>(() => {
    const t = new Date();
    return { y: t.getFullYear(), m: t.getMonth() };
  });
  const [selected, setSelected] = useState<string>(todayKey());
  const today = todayKey();

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/calendar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as CalendarSections & { error?: string; added?: number; moved?: number };
      if (!res.ok) throw new Error(json.error ?? "That did not work.");
      setData(json);
      if (typeof json.added === "number") {
        const bits: string[] = [];
        bits.push(json.added === 0 ? "Nothing new to file — every date in that window is already here." : `${json.added} date${json.added === 1 ? "" : "s"} filed.`);
        if (json.moved) bits.push(`${json.moved} earlier line${json.moved === 1 ? "" : "s"} re-filed under the current rules.`);
        setNote(bits.join(" "));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Dated lines by the day they sit on. */
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarRow[]>();
    for (const r of [...data.upcoming, ...data.past]) {
      map.set(r.bucket, [...(map.get(r.bucket) ?? []), r]);
    }
    return map;
  }, [data]);

  /** Anniversaries by month-and-day, so they recur in every year shown. */
  const byRecurrence = useMemo(() => {
    const map = new Map<string, CalendarRow[]>();
    for (const r of data.annual) map.set(r.bucket, [...(map.get(r.bucket) ?? []), r]);
    return map;
  }, [data]);

  /** What is ahead, dated and recurring together, soonest first. */
  const nextUp = useMemo(() => {
    const items: { on: string; row: CalendarRow }[] = [];
    for (const r of data.upcoming) items.push({ on: r.bucket, row: r });
    for (const r of data.annual) items.push({ on: nextOn(r.bucket), row: r });
    return items.sort((a, b) => a.on.localeCompare(b.on) || a.row.id - b.row.id).slice(0, 12);
  }, [data]);

  const monthKey = `${cursor.y}-${pad(cursor.m + 1)}`;
  const monthName = new Date(cursor.y, cursor.m, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  /** What the sources placed only within the month in view. */
  const placedInMonth = useMemo(
    () =>
      data.sometime.filter(
        (g) =>
          (g.kind === "month" && g.bucket === monthKey) ||
          (g.kind === "week" && g.bucket.startsWith(monthKey)) ||
          (g.kind === "year" && g.bucket === String(cursor.y) && cursor.m === 0)
      ),
    [data, monthKey, cursor]
  );

  /** The grid: Monday-first weeks, leading and trailing days from the
   *  neighbouring months greyed so the rows stay whole. */
  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(cursor.y, cursor.m, 1 - lead);
    const out: { key: string; day: number; inMonth: boolean; dated: CalendarRow[]; annual: CalendarRow[] }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = keyOf(d);
      out.push({
        key,
        day: d.getDate(),
        inMonth: d.getMonth() === cursor.m,
        dated: byDay.get(key) ?? [],
        annual: byRecurrence.get(key.slice(5)) ?? [],
      });
    }
    // Drop a trailing week that holds nothing of this month.
    while (out.length > 35 && out.slice(-7).every((c) => !c.inMonth)) out.splice(-7, 7);
    return out;
  }, [cursor, byDay, byRecurrence]);

  const monthCount = cells.filter((c) => c.inMonth).reduce((n, c) => n + c.dated.length + c.annual.length, 0);

  const selectedDated = byDay.get(selected) ?? [];
  const selectedAnnual = byRecurrence.get(selected.slice(5)) ?? [];

  function goTo(day: string) {
    const [y, m] = day.split("-").map(Number);
    setCursor({ y, m: m - 1 });
    setSelected(day);
  }
  function step(delta: number) {
    const d = new Date(cursor.y, cursor.m + delta, 1);
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
  }
  // Arrow keys page the months when nothing else has the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else if (e.key.toLowerCase() === "t") goTo(today);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, today]);

  const empty = !data.upcoming.length && !data.sometime.length && !data.past.length && !data.annual.length;
  // A line may stand for several records of one happening; dismissing it
  // dismisses them all, or the next one would take its place.
  const idsOf = new Map(
    [...data.upcoming, ...data.past, ...data.annual, ...data.sometime.flatMap((g) => g.items)].map((r) => [r.id, r.ids])
  );
  const dismiss = (id: number) => post({ action: "dismiss", id, ids: idsOf.get(id) ?? [id] });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-3xl font-semibold">
            <IconCalendar size={26} className="text-[var(--color-accent)]" />
            Watching calendar
          </h1>
          <p className="mt-1 max-w-[62ch] text-sm text-[var(--color-muted)]">
            Every date the sources mention — elections, rulings, anniversaries, deadlines — on the day
            the source placed it. A day named without a year for something already done is an
            anniversary, shown when it next comes round, never as this year&apos;s news.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => post({ action: "refresh", days: 30 })}
            title="File every date in the sources of the last thirty days, and re-file earlier lines under the current rules"
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

      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start xl:gap-6">
        {/* ------------------------------------------------------ the month */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Previous month"
              className="rounded-full border border-[var(--color-rule)] px-2.5 py-1 text-sm transition hover:border-[var(--color-accent)]"
            >
              ‹
            </button>
            <h2 className="min-w-[12rem] text-center font-serif text-xl font-semibold">{monthName}</h2>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Next month"
              className="rounded-full border border-[var(--color-rule)] px-2.5 py-1 text-sm transition hover:border-[var(--color-accent)]"
            >
              ›
            </button>
            <button
              type="button"
              onClick={() => goTo(today)}
              className="rounded-full border border-[var(--color-rule)] px-3 py-1 text-xs transition hover:border-[var(--color-accent)]"
            >
              Today
            </button>
            <span className="ml-auto text-xs text-[var(--color-muted)]">
              {monthCount} {monthCount === 1 ? "line" : "lines"} this month
              {placedInMonth.length ? ` · ${placedInMonth.reduce((n, g) => n + g.items.length, 0)} placed only within it` : ""}
              <span className="hidden sm:inline"> · ← → months · T today</span>
            </span>
          </div>

          <div className="overflow-hidden rounded-xl border border-[var(--color-rule)]">
            <div className="grid grid-cols-7 border-b border-[var(--color-rule)] bg-[var(--color-accent-soft)]/30 text-center text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
              {WEEKDAYS.map((w) => (
                <div key={w} className="py-1.5">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((c, i) => {
                const isToday = c.key === today;
                const isSelected = c.key === selected;
                const isPast = c.key < today;
                const total = c.dated.length + c.annual.length;
                const chips = [...c.dated.map((r) => ({ r, ann: false })), ...c.annual.map((r) => ({ r, ann: true }))];
                return (
                  <button
                    type="button"
                    key={c.key}
                    onClick={() => setSelected(c.key)}
                    aria-label={`${formatDate(c.key)}${total ? `, ${total} line${total === 1 ? "" : "s"}` : ""}`}
                    className={`relative flex min-h-[4.5rem] flex-col items-stretch border-b border-r border-[var(--color-rule)] p-1 text-left transition sm:min-h-[6.5rem] ${
                      i % 7 === 6 ? "border-r-0" : ""
                    } ${c.inMonth ? "" : "bg-neutral-50/60 text-neutral-400"} ${
                      isSelected ? "bg-[var(--color-accent-soft)]/60" : "hover:bg-[var(--color-accent-soft)]/25"
                    } ${isPast && c.inMonth ? "text-[var(--color-muted)]" : ""}`}
                  >
                    <span className="flex items-center justify-between">
                      <span
                        className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs ${
                          isToday ? "bg-[var(--color-accent)] font-semibold text-white" : ""
                        }`}
                      >
                        {c.day}
                      </span>
                      {total ? (
                        <span className="text-[10px] text-[var(--color-muted)] sm:hidden">{total}</span>
                      ) : null}
                    </span>
                    <span className="mt-1 hidden flex-1 flex-col gap-0.5 sm:flex">
                      {chips.slice(0, 3).map(({ r, ann }) => (
                        <span
                          key={r.id}
                          title={`${r.text} — ${r.entity}`}
                          className={`truncate rounded px-1 py-0.5 text-[11px] leading-tight ${
                            ann
                              ? "bg-amber-50 text-amber-900 ring-1 ring-amber-200"
                              : "bg-[var(--color-accent-soft)] text-[var(--color-ink)]"
                          }`}
                        >
                          {ann ? "↻ " : ""}
                          {r.text}
                        </span>
                      ))}
                      {chips.length > 3 ? (
                        <span className="px-1 text-[10px] text-[var(--color-muted)]">+{chips.length - 3} more</span>
                      ) : null}
                    </span>
                    {total && !c.inMonth ? null : null}
                    <span className="mt-auto flex gap-0.5 sm:hidden">
                      {chips.slice(0, 4).map(({ r, ann }) => (
                        <span key={r.id} className={`h-1.5 w-1.5 rounded-full ${ann ? "bg-amber-400" : "bg-[var(--color-accent)]"}`} />
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ------------------------------------------------- the chosen day */}
          <div className="rounded-xl border border-[var(--color-rule)]">
            <div className="flex flex-wrap items-baseline gap-2 border-b border-[var(--color-rule)] bg-[var(--color-accent-soft)]/30 px-4 py-2">
              <span className="font-medium">{formatDate(selected)}</span>
              <span className="text-xs text-[var(--color-muted)]">
                {new Date(`${selected}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long" })}
              </span>
              {selected === today ? <Tense tense="current" /> : selected < today ? <Tense tense="past" /> : <Tense tense="upcoming" />}
            </div>
            {selectedDated.length || selectedAnnual.length ? (
              <ul className="divide-y divide-[var(--color-rule)]">
                {selectedDated.map((r) => (
                  <Line key={r.id} row={r} busy={busy} onDismiss={dismiss} />
                ))}
                {selectedAnnual.map((r) => (
                  <Line key={r.id} row={r} busy={busy} onDismiss={dismiss} anniversary />
                ))}
              </ul>
            ) : (
              <p className="px-4 py-4 text-sm text-[var(--color-muted)]">
                Nothing the sources placed on this day.
                {nextUp.length ? (
                  <>
                    {" "}
                    Next is{" "}
                    <button type="button" onClick={() => goTo(nextUp[0].on)} className="text-[var(--color-accent)] hover:underline">
                      {formatDate(nextUp[0].on)}
                    </button>
                    .
                  </>
                ) : null}
              </p>
            )}
          </div>

          {placedInMonth.length ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                Placed only within {monthName.split(" ")[0]}
                <span className="ml-2 text-xs font-normal text-[var(--color-muted)]">
                  the source said the month or the week, not the day
                </span>
              </p>
              {placedInMonth.map((g) => (
                <Group key={`${g.kind}:${g.bucket}`} group={g} busy={busy} onDismiss={dismiss} />
              ))}
            </div>
          ) : null}
        </section>

        {/* ---------------------------------------------------------- next up */}
        <aside className="mt-6 space-y-3 xl:mt-0">
          <h2 className="font-serif text-lg font-semibold">Next up</h2>
          {nextUp.length ? (
            <ol className="divide-y divide-[var(--color-rule)] rounded-xl border border-[var(--color-rule)]">
              {nextUp.map(({ on, row }) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => goTo(on)}
                    className={`block w-full px-3 py-2 text-left transition hover:bg-[var(--color-accent-soft)]/40 ${
                      on === selected ? "bg-[var(--color-accent-soft)]/60" : ""
                    }`}
                  >
                    <span className="flex items-baseline gap-2 text-xs text-[var(--color-muted)]">
                      <span className={on === today ? "font-semibold text-[var(--color-accent)]" : ""}>
                        {on === today ? "Today" : formatDate(on)}
                      </span>
                      {row.kind === "annual" ? <span className="text-amber-800">↻ anniversary</span> : null}
                    </span>
                    <span className="block text-sm leading-snug">{row.text}</span>
                    <span className="block text-xs text-[var(--color-accent)]">{row.entity}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">Nothing ahead on the calendar.</p>
          )}
          {data.annual.length ? (
            <p className="text-xs text-[var(--color-muted)]">
              ↻ marks a day the source gave without a year for something already done. It recurs, and it
              never counts as this year&apos;s news.
            </p>
          ) : null}
        </aside>
      </div>

      {data.sometime.length ? (
        <Section title="Sometime in…" hint="What the sources placed only within a week, a month or a year. Future first.">
          <div className="space-y-4">
            {data.sometime.map((g) => (
              <Group key={`${g.kind}:${g.bucket}`} group={g} busy={busy} onDismiss={dismiss} />
            ))}
          </div>
        </Section>
      ) : null}

      {data.past.length ? (
        <Section
          title="Already happened"
          hint="Dated days that have passed, most recent first — the anniversaries and the things that were 'due'."
          action={
            <button type="button" onClick={() => setShowPast((v) => !v)} className="text-xs text-[var(--color-accent)] hover:underline">
              {showPast ? "Hide" : `Show ${data.past.length}`}
            </button>
          }
        >
          {showPast ? <DayList rows={data.past} busy={busy} onDismiss={dismiss} onPick={goTo} /> : null}
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
    return <span className="rounded-full bg-[var(--color-accent)] px-2 py-0.5 text-[11px] font-medium text-white">today</span>;
  }
  if (tense === "upcoming") {
    return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800">ahead</span>;
  }
  return <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600">past</span>;
}

/** A week, month or year the sources named without a day. */
function Group({ group: g, busy, onDismiss }: { group: CalendarGroup; busy: boolean; onDismiss: (id: number) => void }) {
  return (
    <div className="rounded-xl border border-[var(--color-rule)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-rule)] bg-[var(--color-accent-soft)]/30 px-4 py-2">
        <span className="font-medium">{g.label}</span>
        <Tense tense={g.tense} />
        <span className="ml-auto text-xs text-[var(--color-muted)]">
          {g.items.length} {g.items.length === 1 ? "line" : "lines"}
        </span>
      </div>
      <ul className="divide-y divide-[var(--color-rule)]">
        {g.items.map((r) => (
          <Line key={r.id} row={r} busy={busy} onDismiss={onDismiss} />
        ))}
      </ul>
    </div>
  );
}

/** Exact days, grouped by the day, for the list of what has passed. */
function DayList({
  rows,
  busy,
  onDismiss,
  onPick,
}: {
  rows: CalendarRow[];
  busy: boolean;
  onDismiss: (id: number) => void;
  onPick: (day: string) => void;
}) {
  const byDay = new Map<string, CalendarRow[]>();
  for (const r of rows) byDay.set(r.bucket, [...(byDay.get(r.bucket) ?? []), r]);
  return (
    <div className="space-y-3">
      {[...byDay.entries()].map(([day, items]) => (
        <div key={day} className="rounded-xl border border-[var(--color-rule)]">
          <div className="flex items-center gap-2 border-b border-[var(--color-rule)] bg-[var(--color-accent-soft)]/30 px-4 py-2">
            <button type="button" onClick={() => onPick(day)} className="font-medium hover:text-[var(--color-accent)]">
              {formatDate(day)}
            </button>
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

function Line({
  row,
  busy,
  onDismiss,
  anniversary = false,
}: {
  row: CalendarRow;
  busy: boolean;
  onDismiss: (id: number) => void;
  anniversary?: boolean;
}) {
  return (
    <li className="group flex gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">
          {anniversary ? (
            <span className="mr-1.5 rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900 ring-1 ring-amber-200">
              anniversary
            </span>
          ) : null}
          {row.text}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-[var(--color-muted)]">
          <Link href={`/pedia/${row.entity_id}`} className="font-medium text-[var(--color-accent)] hover:underline">
            {row.entity}
          </Link>
          {row.date_text ? <span className="italic">“{row.date_text}”</span> : null}
          {anniversary ? <span>year not given by the source</span> : null}
          {row.source_id ? (
            <Link
              href={`/sources/${row.source_id}${row.chunk_id ? `?chunk=${row.chunk_id}` : ""}`}
              className="hover:text-[var(--color-accent)] hover:underline"
              title={row.source_title ?? undefined}
            >
              {row.outlet ?? row.source_title ?? "source"}
            </Link>
          ) : null}
          <AlsoSources row={row} />
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
