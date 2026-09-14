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
import { briefSections, headingKey } from "@/lib/brief-sections";
import { IconCalendar, IconX } from "../components/Icons";

interface ExpansionView {
  id: number;
  heading: string;
  state: string;
  body: string;
  error: string | null;
  model: string | null;
  runId: number | null;
}

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
  expansions = [],
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
  watchlist: { id: number; label: string; kind: string; entityId: number | null; recent: number; source: string }[];
  stats: Record<string, number>;
  /** The dates this brief noticed, for the block under it. */
  calendar?: CalendarRow[];
  /** The expanded looks written for this brief's headings. */
  expansions?: ExpansionView[];
}) {
  const router = useRouter();
  const [openCite, setOpenCite] = useState<{ id: number; anchor: HTMLElement } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);

  const citationMap = useMemo(() => new Map(citations.map((c) => [c.id, c])), [citations]);
  const open = openCite ? citationMap.get(openCite.id) : undefined;

  // --- Following, and not following ----------------------------------------
  const [phrase, setPhrase] = useState("");
  const [watchBusy, setWatchBusy] = useState(false);

  /** Stops following something. One Corpus added itself is not suggested again. */
  async function unwatch(id: number) {
    setWatchBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/watchlist?id=${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "That did not work.");
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWatchBusy(false);
    }
  }

  async function follow() {
    const words = phrase.trim();
    if (!words) return;
    setWatchBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phrase: words }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "That did not work.");
      }
      setPhrase("");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWatchBusy(false);
    }
  }

  // --- Expanded looks ---------------------------------------------------------
  const sections = useMemo(
    () => new Map(briefSections(brief?.body ?? "").map((s) => [s.heading, s])),
    [brief?.body]
  );
  const expansionOf = useMemo(() => new Map(expansions.map((x) => [x.heading, x])), [expansions]);
  /** Runs started from this page, by heading, until they finish. */
  const [expandRuns, setExpandRuns] = useState<Record<string, number>>({});
  const [expandErrors, setExpandErrors] = useState<Record<string, string>>({});
  /** Written looks you have folded away. */
  const [folded, setFolded] = useState<Set<string>>(new Set());

  async function expand(heading: string, force: boolean) {
    if (!brief) return;
    setExpandErrors(({ [heading]: _gone, ...rest }) => rest);
    setFolded((f) => {
      const next = new Set(f);
      next.delete(heading);
      return next;
    });
    try {
      const res = await fetch("/api/brief/expand", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ day: brief.day, heading, force }),
      });
      const data = (await res.json().catch(() => ({}))) as { runId?: number | null; note?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "That did not work.");
      if (data.runId) setExpandRuns((r) => ({ ...r, [heading]: data.runId! }));
      else router.refresh();
    } catch (err) {
      setExpandErrors((e) => ({ ...e, [heading]: (err as Error).message }));
    }
  }

  /** The Expand button, on a heading whose section cites something to expand from. */
  const expandButton = (h: { text: string; level: number }) => {
    const key = headingKey(h.text);
    const section = sections.get(key);
    if (!brief || h.level < 2 || !section || section.mentionIds.length === 0) return null;
    const written = expansionOf.get(key);
    const running = Boolean(expandRuns[key] ?? written?.runId);
    const done = written?.state === "done";
    const label = running ? "Expanding…" : done ? (folded.has(key) ? "Show expanded" : "Hide expanded") : "Expand";
    return (
      <button
        type="button"
        disabled={running}
        onClick={() =>
          done
            ? setFolded((f) => {
                const next = new Set(f);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            : void expand(key, false)
        }
        title={
          done
            ? "Show or hide the expanded look"
            : "Write a closer look at this from the passages cited here, the rest of those articles, and earlier coverage in your library"
        }
        className="ms-2 inline-flex items-center rounded-full border border-[var(--color-rule)] px-2 py-0.5 align-middle font-sans text-[0.7rem] font-normal normal-case tracking-normal text-[var(--color-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-60"
      >
        {label}
      </button>
    );
  };

  /** The expanded look, under the whole section it expands. */
  const expandedLook = (h: { text: string; level: number }) => {
    const key = headingKey(h.text);
    const written = expansionOf.get(key);
    const run = expandRuns[key] ?? written?.runId ?? null;
    const problem = expandErrors[key];
    if (!written && !run && !problem) return null;
    if (written?.state === "done" && folded.has(key) && !run) return null;

    return (
      <aside className="my-5 rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)]/20 px-4 py-3 font-sans">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-accent)]">Expanded · {key}</span>
          {run ? (
            <RunChip
              runId={run}
              onDone={() => {
                setExpandRuns(({ [key]: _done, ...rest }) => rest);
                router.refresh();
              }}
            />
          ) : null}
          {written?.state === "done" && !run ? (
            <button
              type="button"
              onClick={() => void expand(key, true)}
              className="ms-auto text-xs text-[var(--color-muted)] transition hover:text-[var(--color-accent)]"
            >
              Write it again
            </button>
          ) : null}
        </div>

        {problem ? <p className="mt-2 text-sm text-red-800">{problem}</p> : null}

        {run ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Reading everything the library has on it — the passages cited here, the rest of those articles, and earlier
            coverage. This takes a minute or two.
          </p>
        ) : written?.state === "failed" ? (
          <p className="mt-2 text-sm text-red-800">
            {written.error ?? "It could not be written."}{" "}
            <button type="button" onClick={() => void expand(key, false)} className="underline">
              Try again
            </button>
          </p>
        ) : written?.state === "done" && written.body ? (
          <div className="mt-2">
            <EntryBody
              body={written.body}
              citations={citationMap}
              onCite={(id, anchor) => setOpenCite((cur) => (cur?.id === id ? null : { id, anchor }))}
              activeId={openCite?.id}
            />
            {written.model ? (
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Written by <Badge>{written.model}</Badge>.
              </p>
            ) : null}
          </div>
        ) : written?.state === "pending" ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            It stopped before it finished.{" "}
            <button type="button" onClick={() => void expand(key, false)} className="underline">
              Try again
            </button>
          </p>
        ) : null}
      </aside>
    );
  };

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

      {/* What the brief is built around — and the one place to change it. The
          cross stops following something; one Corpus added on its own is not
          suggested again. People and institutions are followed from their
          pedia page, topics arrive as the library files them, phrases here. */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className="text-[var(--color-muted)]"
          title="Topics are added as they come up across outlets; people and institutions from their pedia page; phrases here."
        >
          Watching:
        </span>
        {watchlist.length === 0 ? (
          <span className="text-[var(--color-muted)]">
            nothing yet. Watch a person or institution from their pedia page, or follow a phrase.
          </span>
        ) : null}
        {watchlist.map((w) => (
          <span
            key={w.id}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-rule)] py-0.5 pe-1 ps-2"
            title={w.source === "auto" ? "Added by Corpus because it kept coming up" : undefined}
          >
            {w.entityId ? (
              <Link href={`/pedia/${w.entityId}`} className="hover:text-[var(--color-accent)]">
                {w.label}
              </Link>
            ) : w.kind === "phrase" ? (
              <span>“{w.label}”</span>
            ) : (
              w.label
            )}
            {w.recent > 0 ? (
              <span className="rounded-full bg-[var(--color-accent-soft)] px-1.5 text-xs text-[var(--color-accent)]">
                {w.recent}
              </span>
            ) : null}
            <button
              type="button"
              disabled={watchBusy}
              onClick={() => void unwatch(w.id)}
              title={
                w.source === "auto"
                  ? `Stop following ${w.label}. Corpus added it, and will not suggest it again.`
                  : `Stop following ${w.label}`
              }
              aria-label={`Stop following ${w.label}`}
              className="rounded-full p-0.5 text-[var(--color-muted)] opacity-50 transition hover:bg-red-50 hover:text-red-700 hover:opacity-100 disabled:opacity-20"
            >
              <IconX size={12} />
            </button>
          </span>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void follow();
          }}
          className="inline-flex items-center gap-1"
        >
          <input
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="Follow a phrase…"
            aria-label="Follow a phrase"
            className="w-40 rounded-full border border-[var(--color-rule)] bg-white px-2.5 py-0.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          {phrase.trim() ? (
            <button
              type="submit"
              disabled={watchBusy}
              className="rounded-full bg-[var(--color-accent)] px-2.5 py-0.5 text-xs text-white disabled:opacity-50"
            >
              Follow
            </button>
          ) : null}
        </form>
      </div>

      {brief && brief.state === "done" && brief.body ? (
        <>
          <article className="max-w-[70ch]">
            <EntryBody
              body={brief.body}
              citations={citationMap}
              onCite={(id, anchor) => setOpenCite((cur) => (cur?.id === id ? null : { id, anchor }))}
              activeId={openCite?.id}
              headingExtra={expandButton}
              sectionEnd={expandedLook}
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
