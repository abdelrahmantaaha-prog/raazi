"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RunChip } from "../components/RunChip";
import { Empty } from "../components/ui";
import { formatDateTime, relativeDate } from "@/lib/dates";

interface Item {
  id: number;
  feed_id: number;
  feed_title: string;
  outlet: string | null;
  reliability: string | null;
  title: string;
  summary: string | null;
  url: string | null;
  published_at: string | null;
  seen_at: string;
  source_id: number | null;
  note: string | null;
  lede: string | null;
  chunks: number;
  story_id: number | null;
  story_title: string | null;
  story_accounts: number;
}

/**
 * The inbox: everything the feeds pulled in, waiting on a yes or a no.
 *
 * This page is the only place in the application where the reading pipeline
 * starts. That is the whole design — the expensive stage cannot run until you
 * have looked at a headline and a first paragraph and said the piece is worth
 * it — so the page is built for going fast: grouped by story so five accounts
 * of one thing are one decision, keyboard-free bulk actions per group, and a
 * discard that is reversible for as long as you have not left.
 *
 * What it deliberately does not do is summarise anything with a model. Judging
 * an article by a summary of it is the failure this whole app exists to avoid,
 * and it would also cost exactly what the inbox is here to save.
 */
export default function Inbox({
  initial,
  held,
  reviewOn,
}: {
  initial: Item[];
  held: number;
  reviewOn: boolean;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [count, setCount] = useState(held);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [lastDiscarded, setLastDiscarded] = useState<number[]>([]);

  /** Grouped by story where there is one, so duplicates arrive as one item. */
  const groups = useMemo(() => {
    const byStory = new Map<string, { key: string; title: string; storyId: number | null; items: Item[] }>();
    for (const item of items) {
      const key = item.story_id ? `s${item.story_id}` : `i${item.id}`;
      const existing = byStory.get(key);
      if (existing) existing.items.push(item);
      else
        byStory.set(key, {
          key,
          title: item.story_title ?? item.title,
          storyId: item.story_id,
          items: [item],
        });
    }
    return [...byStory.values()];
  }, [items]);

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectGroup = (group: { items: Item[] }) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const all = group.items.every((i) => next.has(i.id));
      for (const i of group.items) {
        if (all) next.delete(i.id);
        else next.add(i.id);
      }
      return next;
    });

  async function act(action: "keep" | "discard" | "undo", itemIds: number[]) {
    if (!itemIds.length) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, itemIds }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        items?: Item[];
        held?: number;
        runId?: number | null;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "That did not work.");
      if (data.items) setItems(data.items);
      if (typeof data.held === "number") setCount(data.held);
      if (data.runId) setRunId(data.runId);
      setSelected(new Set());
      setLastDiscarded(action === "discard" ? itemIds : []);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const selectedIds = [...selected];
  const allIds = items.map((i) => i.id);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-semibold">Inbox</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {count === 0
              ? "Nothing waiting. Everything the feeds brought in has been through you."
              : `${count} article${count === 1 ? "" : "s"} pulled in and waiting. Nothing here has been read yet — keeping one is what starts it.`}
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
          <Link
            href="/week"
            className="rounded border border-[var(--color-rule)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)]"
          >
            This week
          </Link>
          <Link
            href="/feeds"
            className="rounded border border-[var(--color-rule)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)]"
          >
            Feeds
          </Link>
        </div>
      </header>

      {!reviewOn ? (
        <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Review is switched off in Settings, so feeds are reading everything they find straight away.
          Anything below arrived before that was turned off.
        </p>
      ) : null}

      {error ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>
      ) : null}

      {items.length > 0 ? (
        <div className="sticky top-0 z-10 -mx-2 flex flex-wrap items-center gap-2 border-b border-[var(--color-rule)] bg-white/90 px-2 py-2 backdrop-blur">
          <button
            type="button"
            disabled={busy || !selectedIds.length}
            onClick={() => act("keep", selectedIds)}
            className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            Keep {selectedIds.length || ""}
          </button>
          <button
            type="button"
            disabled={busy || !selectedIds.length}
            onClick={() => act("discard", selectedIds)}
            className="rounded border border-[var(--color-rule)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)] disabled:opacity-40"
          >
            Discard {selectedIds.length || ""}
          </button>
          <span className="mx-1 h-4 w-px bg-[var(--color-rule)]" />
          <button
            type="button"
            disabled={busy}
            onClick={() => setSelected(new Set(allIds))}
            className="text-sm text-[var(--color-muted)] hover:text-[var(--color-accent)]"
          >
            Select all
          </button>
          <button
            type="button"
            disabled={busy || !selectedIds.length}
            onClick={() => setSelected(new Set())}
            className="text-sm text-[var(--color-muted)] hover:text-[var(--color-accent)] disabled:opacity-40"
          >
            Clear
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => act("discard", allIds)}
            className="ml-auto text-sm text-[var(--color-muted)] hover:text-[var(--color-accent)]"
            title="Everything here goes; nothing is read"
          >
            Discard the rest
          </button>
          {lastDiscarded.length ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => act("undo", lastDiscarded)}
              className="text-sm text-[var(--color-accent)] hover:underline"
            >
              Undo last discard ({lastDiscarded.length})
            </button>
          ) : null}
        </div>
      ) : null}

      {items.length === 0 ? (
        <Empty
          title="Nothing waiting"
          hint="The feeds check themselves while Corpus is open. What they bring in lands here first."
        />
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <section
              key={group.key}
              className="rounded border border-[var(--color-rule)] p-3"
            >
              {group.items.length > 1 || group.storyId ? (
                <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">
                    {group.storyId ? (
                      <Link href={`/stories/${group.storyId}`} className="hover:text-[var(--color-accent)]">
                        {group.title}
                      </Link>
                    ) : (
                      group.title
                    )}
                  </span>
                  <span className="text-xs text-[var(--color-muted)]">
                    {group.items.length} account{group.items.length === 1 ? "" : "s"} waiting
                    {group.items[0].story_accounts > group.items.length
                      ? `, ${group.items[0].story_accounts - group.items.length} already in the library`
                      : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => selectGroup(group)}
                    className="text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]"
                  >
                    Select all in this story
                  </button>
                </div>
              ) : null}

              <ul className="space-y-3">
                {group.items.map((item) => (
                  <li key={item.id} className="flex gap-3">
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={() => toggle(item.id)}
                      className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                      aria-label={`Select ${item.title}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <h2 className="font-medium">
                          {item.url ? (
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:text-[var(--color-accent)]"
                              title="Open the article on the outlet's own site"
                            >
                              {item.title}
                            </a>
                          ) : (
                            item.title
                          )}
                        </h2>
                        <span className="text-xs text-[var(--color-muted)]">
                          {[item.outlet ?? item.feed_title, item.published_at ? relativeDate(item.published_at) : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </div>

                      {item.lede ? (
                        <p className="mt-1 text-sm text-[var(--color-muted)]">{item.lede}</p>
                      ) : item.summary ? (
                        <p className="mt-1 text-sm text-[var(--color-muted)]">
                          {item.summary.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400)}
                        </p>
                      ) : (
                        <p className="mt-1 text-sm text-amber-700">
                          The page would not open; only the headline came through.
                        </p>
                      )}

                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-[var(--color-muted)]">
                        <span title={formatDateTime(item.seen_at)}>
                          pulled {relativeDate(item.seen_at)}
                        </span>
                        {item.chunks > 0 ? <span>{item.chunks} passage{item.chunks === 1 ? "" : "s"}</span> : null}
                        {item.reliability ? <span>{item.reliability}</span> : null}
                        {item.note ? <span>{item.note}</span> : null}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => act("keep", [item.id])}
                          className="text-[var(--color-accent)] hover:underline"
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => act("discard", [item.id])}
                          className="hover:text-[var(--color-accent)] hover:underline"
                        >
                          Discard
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
