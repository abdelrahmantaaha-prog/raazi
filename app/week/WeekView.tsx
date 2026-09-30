"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EntryBody, type Citation } from "../components/EntryBody";
import { CitationPopover } from "../components/CitationPopover";
import { RunChip } from "../components/RunChip";
import { Badge } from "../components/ui";
import { formatDate, relativeDate } from "@/lib/dates";

interface WeekCitation extends Citation {
  chunkId: number | null;
  entityId: number;
  entityName: string;
  outlet: string | null;
  publishedAt: string | null;
  url: string | null;
}

interface Kept {
  source_id: number;
  title: string;
  outlet: string | null;
  url: string | null;
  published_at: string | null;
  kept_at: string | null;
  passages: number;
  story_id: number | null;
  story_title: string | null;
  feed_title: string | null;
}

/**
 * The week as it fills, and the brief written from it.
 *
 * Two halves, deliberately in this order. Above: what you kept, grouped by
 * story, growing every time you clear the inbox — this is the record, it is
 * true whether or not anything has been written, and it is what you check the
 * brief against. Below: the brief itself, which is one call over the passages
 * those articles produced and carries a marker on every line.
 */
export default function WeekView({
  week,
  label,
  current,
  previous,
  next,
  brief,
  citations,
  kept,
  discarded,
  held,
  weeks,
}: {
  week: string;
  label: string;
  current: boolean;
  from: string;
  to: string;
  previous: string;
  next: string | null;
  brief: { body: string; state: string; error: string | null; createdAt: string; model: string | null } | null;
  citations: WeekCitation[];
  kept: Kept[];
  discarded: number;
  held: number;
  weeks: { week: string; state: string }[];
}) {
  const router = useRouter();
  const [openCite, setOpenCite] = useState<{ id: number; anchor: HTMLElement } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);

  const citationMap = useMemo(() => new Map(citations.map((c) => [c.id, c])), [citations]);
  const open = openCite ? citationMap.get(openCite.id) : undefined;

  const groups = useMemo(() => {
    const byStory = new Map<string, { key: string; title: string; storyId: number | null; items: Kept[] }>();
    for (const k of kept) {
      const key = k.story_id ? `s${k.story_id}` : `a${k.source_id}`;
      const existing = byStory.get(key);
      if (existing) existing.items.push(k);
      else byStory.set(key, { key, title: k.story_title ?? k.title, storyId: k.story_id, items: [k] });
    }
    return [...byStory.values()].sort((a, b) => b.items.length - a.items.length);
  }, [kept]);

  const unread = kept.filter((k) => k.passages === 0).length;

  async function write(force: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/brief/week", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ week, force }),
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

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-semibold">{current ? "This week" : label}</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {current ? `${label}. ` : ""}
            Friday to Thursday. {kept.length} article{kept.length === 1 ? "" : "s"} kept
            {discarded > 0 ? ` of ${kept.length + discarded} looked at` : ""}
            {unread > 0 ? `, ${unread} still being read` : ""}
            {held > 0 ? ` · ${held} waiting in the inbox` : ""}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {runId ? (
            <RunChip
              runId={runId}
              onDone={() => {
                setRunId(null);
                router.refresh();
              }}
            />
          ) : null}
          <button
            type="button"
            onClick={() => write(Boolean(brief && brief.state === "done"))}
            disabled={busy || kept.length === 0}
            className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
            title={
              kept.length === 0
                ? "Nothing kept this week yet"
                : "One call over everything this week's articles produced"
            }
          >
            {busy ? "Asking…" : brief?.state === "done" ? "Write it again" : "Write the weekly brief"}
          </button>
          {held > 0 ? (
            <Link
              href="/inbox"
              className="rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-900"
            >
              {held} to go through
            </Link>
          ) : null}
        </div>
      </header>

      {error ? (
        <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--color-muted)]">
          What you kept{groups.length ? ` — ${groups.length} thread${groups.length === 1 ? "" : "s"}` : ""}
        </h2>
        {kept.length === 0 ? (
          <p className="rounded border border-dashed border-[var(--color-rule)] px-4 py-6 text-sm text-[var(--color-muted)]">
            Nothing yet this week. What you keep in the <Link href="/inbox" className="underline">inbox</Link> lands
            here, and the brief is written from it.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-rule)] rounded border border-[var(--color-rule)]">
            {groups.map((g) => (
              <li key={g.key} className="px-3 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {g.storyId ? (
                      <Link href={`/stories/${g.storyId}`} className="hover:text-[var(--color-accent)]">
                        {g.title}
                      </Link>
                    ) : (
                      <Link href={`/sources/${g.items[0].source_id}`} className="hover:text-[var(--color-accent)]">
                        {g.title}
                      </Link>
                    )}
                  </span>
                  <span className="text-xs text-[var(--color-muted)]">
                    {g.items.length > 1 ? `${g.items.length} accounts · ` : ""}
                    {[...new Set(g.items.map((i) => i.outlet ?? i.feed_title).filter(Boolean))].join(", ")}
                  </span>
                </div>
                {g.items.length > 1 ? (
                  <ul className="mt-1 space-y-0.5 text-xs text-[var(--color-muted)]">
                    {g.items.map((i) => (
                      <li key={i.source_id}>
                        <Link href={`/sources/${i.source_id}`} className="hover:text-[var(--color-accent)]">
                          {i.title}
                        </Link>
                        {i.kept_at ? ` · kept ${relativeDate(i.kept_at)}` : ""}
                        {i.passages === 0 ? " · being read" : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                    {g.items[0].kept_at ? `kept ${relativeDate(g.items[0].kept_at)}` : ""}
                    {g.items[0].passages === 0 ? " · being read" : ` · ${g.items[0].passages} passages`}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {brief && brief.state === "done" && brief.body ? (
        <section className="space-y-3 border-t border-[var(--color-rule)] pt-6">
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--color-muted)]">
            <span>The brief · written {formatDate(brief.createdAt, { time: true })}</span>
            {brief.model ? <Badge>{brief.model}</Badge> : null}
          </h2>
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
        </section>
      ) : brief && brief.state === "pending" ? (
        <p className="border-t border-[var(--color-rule)] pt-6 text-sm text-[var(--color-muted)]">
          Being written now. It will appear here.
        </p>
      ) : brief && brief.state === "failed" ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {brief.error ?? "The brief could not be written."}
        </p>
      ) : null}

      <nav className="flex flex-wrap items-center gap-3 border-t border-[var(--color-rule)] pt-4 text-sm">
        {brief?.state === "done" ? (
          <a href={`/api/export?format=pdf&brief=${encodeURIComponent(week)}`} className="rounded border border-[var(--color-rule)] px-2 py-0.5 hover:border-[var(--color-accent)]">
            PDF
          </a>
        ) : null}
        <Link href={`/week?week=${previous.replace("week:", "")}`} className="hover:text-[var(--color-accent)]">
          ← the week before
        </Link>
        {next ? (
          <Link href={`/week?week=${next.replace("week:", "")}`} className="hover:text-[var(--color-accent)]">
            the week after →
          </Link>
        ) : null}
        {weeks.length ? (
          <>
            <span className="text-[var(--color-muted)]">Written:</span>
            {weeks.map((w) => (
              <Link
                key={w.week}
                href={`/week?week=${w.week.replace("week:", "")}`}
                className={`rounded px-2 py-0.5 hover:bg-[var(--color-accent-soft)] ${
                  w.week === week ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : ""
                }`}
              >
                {w.week.replace("week:", "")}
              </Link>
            ))}
          </>
        ) : null}
      </nav>
    </div>
  );
}
