"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RunChip } from "../components/RunChip";
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
 * This page is the only place the reading pipeline starts, so it is built for
 * going fast rather than for looking at. Three things do that work.
 *
 * Grouping by story, so five accounts of one thing are one decision. Filtering
 * by outlet, because "clear the wires first" is how you actually triage.
 * And a keyboard: J and K move, K keeps, D discards, P opens the paste box, so
 * a hundred items is a rhythm rather than a hundred trips to the mouse.
 *
 * What it deliberately does not do is summarise anything with a model. Judging
 * an article by a machine summary of it is the failure this whole application
 * exists to avoid, and it would cost exactly what the inbox is here to save.
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
  const [outlet, setOutlet] = useState<string | null>(null);
  const [pasting, setPasting] = useState<number | null>(null);
  const [pasted, setPasted] = useState("");
  const [cursor, setCursor] = useState(0);

  /** Outlets, biggest first — the filter bar doubles as a picture of the day. */
  const outlets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of items) {
      const name = i.outlet ?? i.feed_title;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  const visible = useMemo(
    () => (outlet ? items.filter((i) => (i.outlet ?? i.feed_title) === outlet) : items),
    [items, outlet]
  );

  /** Grouped by story, so duplicates arrive as one decision. */
  const groups = useMemo(() => {
    const byStory = new Map<string, { key: string; title: string; storyId: number | null; items: Item[] }>();
    for (const item of visible) {
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
    return [...byStory.values()].sort((a, b) => b.items.length - a.items.length);
  }, [visible]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

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
      setCursor((c) => Math.max(0, Math.min(c, (data.items?.length ?? 1) - 1)));
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function savePaste(itemId: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "paste", itemIds: [itemId], text: pasted }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        items?: Item[];
        words?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "That did not work.");
      if (data.items) setItems(data.items);
      setPasting(null);
      setPasted("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** J/K to move, K to keep, D to discard, P to paste. Not while typing. */
  function onKey(e: React.KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || pasting !== null) return;
    const here = flat[cursor];
    if (e.key === "j") setCursor((c) => Math.min(c + 1, flat.length - 1));
    else if (e.key === "k") setCursor((c) => Math.max(c - 1, 0));
    else if (e.key === "Enter" && here) void act("keep", [here.id]);
    else if (e.key === "d" && here) void act("discard", [here.id]);
    else if (e.key === "p" && here) {
      setPasting(here.id);
      setPasted("");
    } else if (e.key === "x" && here) toggle(here.id);
    else return;
    e.preventDefault();
  }

  const selectedIds = [...selected];
  const visibleIds = visible.map((i) => i.id);

  return (
    <div className="space-y-5" onKeyDown={onKey} tabIndex={-1}>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-3">
            <h1 className="font-serif text-3xl font-semibold">Inbox</h1>
            {count > 0 ? (
              <span className="rounded-full bg-[var(--color-accent)] px-2.5 py-0.5 text-sm font-medium text-white">
                {count}
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-[62ch] text-sm text-[var(--color-muted)]">
            {count === 0
              ? "Nothing waiting. Everything the feeds brought in has been through you."
              : "Pulled in and unread — nothing here has cost a token yet. Keeping one is what starts the reading."}
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
            className="rounded-full border border-[var(--color-rule)] px-3 py-1.5 text-sm transition hover:border-[var(--color-accent)]"
          >
            This week
          </Link>
          <Link
            href="/feeds"
            className="rounded-full border border-[var(--color-rule)] px-3 py-1.5 text-sm transition hover:border-[var(--color-accent)]"
          >
            Feeds
          </Link>
        </div>
      </header>

      {!reviewOn ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Review is switched off in Settings, so feeds are reading everything they find straight away.
          Anything below arrived before that was turned off.
        </p>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>
      ) : null}

      {items.length > 0 ? (
        <>
          {/* Outlets, as a filter and as a shape of the day. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setOutlet(null)}
              className={`rounded-full px-3 py-1 text-xs transition ${
                outlet === null
                  ? "bg-[var(--color-ink)] text-white"
                  : "border border-[var(--color-rule)] hover:border-[var(--color-accent)]"
              }`}
            >
              Everything {items.length}
            </button>
            {outlets.map(([name, n]) => (
              <button
                key={name}
                type="button"
                onClick={() => setOutlet(outlet === name ? null : name)}
                className={`rounded-full px-3 py-1 text-xs transition ${
                  outlet === name
                    ? "bg-[var(--color-ink)] text-white"
                    : "border border-[var(--color-rule)] hover:border-[var(--color-accent)]"
                }`}
              >
                {name} <span className="opacity-60">{n}</span>
              </button>
            ))}
          </div>

          {/* The action bar follows you down the page. */}
          <div className="sticky top-0 z-20 -mx-2 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-rule)] bg-white/85 px-3 py-2 backdrop-blur">
            <button
              type="button"
              disabled={busy || !selectedIds.length}
              onClick={() => act("keep", selectedIds)}
              className="rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white transition disabled:opacity-30"
            >
              Keep{selectedIds.length ? ` ${selectedIds.length}` : ""}
            </button>
            <button
              type="button"
              disabled={busy || !selectedIds.length}
              onClick={() => act("discard", selectedIds)}
              className="rounded-full border border-[var(--color-rule)] px-4 py-1.5 text-sm transition hover:border-red-400 hover:text-red-700 disabled:opacity-30"
            >
              Discard{selectedIds.length ? ` ${selectedIds.length}` : ""}
            </button>
            <span className="mx-1 h-4 w-px bg-[var(--color-rule)]" />
            <button
              type="button"
              onClick={() => setSelected(new Set(visibleIds))}
              className="text-xs text-[var(--color-muted)] transition hover:text-[var(--color-accent)]"
            >
              Select all {outlet ? `from ${outlet}` : ""}
            </button>
            {selectedIds.length ? (
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-xs text-[var(--color-muted)] transition hover:text-[var(--color-accent)]"
              >
                Clear
              </button>
            ) : null}
            {lastDiscarded.length ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => act("undo", lastDiscarded)}
                className="text-xs text-[var(--color-accent)] hover:underline"
              >
                Undo {lastDiscarded.length}
              </button>
            ) : null}
            <span className="ml-auto hidden text-xs text-[var(--color-muted)] sm:inline">
              <kbd className="rounded border border-[var(--color-rule)] px-1">j</kbd>{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">k</kbd> move ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">↵</kbd> keep ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">d</kbd> discard ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">p</kbd> paste
            </span>
          </div>
        </>
      ) : null}

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-rule)] px-6 py-16 text-center">
          <p className="font-serif text-xl">Nothing waiting</p>
          <p className="mx-auto mt-2 max-w-[46ch] text-sm text-[var(--color-muted)]">
            The feeds check themselves on their own schedule while Corpus is open. What they bring in
            lands here first, and waits.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => {
            const many = group.items.length > 1;
            return (
              <section
                key={group.key}
                className={`overflow-hidden rounded-xl border transition ${
                  many ? "border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)]/20" : "border-[var(--color-rule)]"
                }`}
              >
                {many ? (
                  <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-rule)] bg-[var(--color-accent-soft)]/40 px-4 py-2">
                    <span className="text-sm font-medium">
                      {group.storyId ? (
                        <Link href={`/stories/${group.storyId}`} className="hover:text-[var(--color-accent)]">
                          {group.title}
                        </Link>
                      ) : (
                        group.title
                      )}
                    </span>
                    <span className="text-xs text-[var(--color-muted)]">
                      {group.items.length} accounts of one story
                      {group.items[0].story_accounts > group.items.length
                        ? `, ${group.items[0].story_accounts - group.items.length} already kept`
                        : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => selectGroup(group)}
                      className="ml-auto text-xs text-[var(--color-muted)] transition hover:text-[var(--color-accent)]"
                    >
                      Select all
                    </button>
                  </div>
                ) : null}

                <ul className="divide-y divide-[var(--color-rule)]">
                  {group.items.map((item) => {
                    const isCursor = flat[cursor]?.id === item.id;
                    const chosen = selected.has(item.id);
                    const thin = item.chunks <= 1 && !item.lede;
                    return (
                      <li
                        key={item.id}
                        onMouseEnter={() => setCursor(flat.findIndex((f) => f.id === item.id))}
                        className={`group relative px-4 py-3 transition ${
                          chosen ? "bg-[var(--color-accent-soft)]/60" : "hover:bg-[var(--color-accent-soft)]/25"
                        }`}
                      >
                        {isCursor ? (
                          <span className="absolute inset-y-0 left-0 w-[3px] bg-[var(--color-accent)]" />
                        ) : null}

                        <div className="flex gap-3">
                          <input
                            type="checkbox"
                            checked={chosen}
                            onChange={() => toggle(item.id)}
                            className="mt-1.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                            aria-label={`Select ${item.title}`}
                          />

                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2">
                              <h2 className="font-medium leading-snug">
                                {item.url ? (
                                  <a
                                    href={item.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="transition hover:text-[var(--color-accent)]"
                                    title="Open it on the outlet's own site"
                                  >
                                    {item.title}
                                  </a>
                                ) : (
                                  item.title
                                )}
                              </h2>
                              <span className="text-xs text-[var(--color-muted)]">
                                {item.outlet ?? item.feed_title}
                                {item.published_at ? ` · ${relativeDate(item.published_at)}` : ""}
                              </span>
                              {thin ? (
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800">
                                  headline only
                                </span>
                              ) : null}
                              {item.note === "Full text pasted in." ? (
                                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800">
                                  full text
                                </span>
                              ) : null}
                            </div>

                            <p className="mt-1 text-sm leading-relaxed text-[var(--color-muted)]">
                              {item.lede ??
                                (item.summary
                                  ? item.summary.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400)
                                  : "The page would not open — paste the article in and it becomes a real source.")}
                            </p>

                            {pasting === item.id ? (
                              <div className="mt-3 rounded-lg border border-[var(--color-accent)]/50 bg-white p-3">
                                <p className="text-xs text-[var(--color-muted)]">
                                  Open it where you are signed in, select the article, and paste it here. The
                                  address, outlet and date stay as they are — this only replaces the text.
                                </p>
                                <textarea
                                  autoFocus
                                  value={pasted}
                                  onChange={(e) => setPasted(e.target.value)}
                                  rows={10}
                                  placeholder="Paste the full article…"
                                  className="mt-2 w-full rounded border border-[var(--color-rule)] p-2 text-sm outline-none focus:border-[var(--color-accent)]"
                                />
                                <div className="mt-2 flex items-center gap-2">
                                  <button
                                    type="button"
                                    disabled={busy || pasted.trim().length < 200}
                                    onClick={() => void savePaste(item.id)}
                                    className="rounded-full bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-30"
                                  >
                                    Save the text
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setPasting(null);
                                      setPasted("");
                                    }}
                                    className="text-sm text-[var(--color-muted)] hover:text-[var(--color-accent)]"
                                  >
                                    Cancel
                                  </button>
                                  <span className="ml-auto text-xs text-[var(--color-muted)]">
                                    {pasted.trim() ? `${pasted.trim().split(/\s+/).length} words` : "nothing yet"}
                                  </span>
                                </div>
                              </div>
                            ) : null}

                            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-muted)]">
                              <span title={formatDateTime(item.seen_at)}>pulled {relativeDate(item.seen_at)}</span>
                              {item.chunks > 0 ? (
                                <span>
                                  {item.chunks} passage{item.chunks === 1 ? "" : "s"}
                                </span>
                              ) : null}
                              {item.reliability ? <span className="italic">{item.reliability}</span> : null}

                              <span className="ms-auto flex items-center gap-3 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    setPasting(pasting === item.id ? null : item.id);
                                    setPasted("");
                                  }}
                                  className="transition hover:text-[var(--color-accent)]"
                                >
                                  Paste text
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => act("discard", [item.id])}
                                  className="transition hover:text-red-700"
                                >
                                  Discard
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => act("keep", [item.id])}
                                  className="rounded-full bg-[var(--color-accent)] px-3 py-1 font-medium text-white transition"
                                >
                                  Keep
                                </button>
                              </span>
                            </div>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
