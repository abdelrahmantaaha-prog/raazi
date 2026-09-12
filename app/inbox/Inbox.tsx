"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RunChip } from "../components/RunChip";
import { Modal } from "../components/Modal";
import {
  IconCheck,
  IconClipboard,
  IconExternal,
  IconEye,
  IconFeed,
  IconSelectAll,
  IconText,
  IconUndo,
  IconWeek,
  IconX,
} from "../components/Icons";
import { formatDateTime, relativeDate } from "@/lib/dates";
import { dirOf } from "@/lib/dir";
import type { HeldText } from "@/lib/triage";

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
  chars: number;
  story_id: number | null;
  story_title: string | null;
  story_accounts: number;
  image: string | null;
  source_note: string | null;
}

/**
 * The inbox: everything the feeds pulled in, waiting on a yes or a no.
 *
 * This page is the only place the reading pipeline starts, so it is built for
 * going fast rather than for looking at. Three things do that work.
 *
 * Grouping by story, so five accounts of one thing are one decision. Filtering
 * by outlet, because "clear the wires first" is how you actually triage.
 * And a keyboard: J and K move, Enter keeps, D discards, P opens the paste box,
 * so a hundred items is a rhythm rather than a hundred trips to the mouse.
 *
 * On a wide screen the item under the cursor opens in a pane on the right:
 * the text the fetch actually got, with a verdict on whether it is the
 * article or a paywall's stub. That is the question the paste box exists to
 * answer, and it used to be answerable only by keeping the item and finding
 * out. On a phone the same pane opens as a sheet from the eye button.
 *
 * What it deliberately does not do is summarise anything with a model. Judging
 * an article by a machine summary of it is the failure this whole application
 * exists to avoid, and it would cost exactly what the inbox is here to save.
 */
/** Matches ENOUGH_TO_READ in lib/triage.ts: below this there is no article. */
const ENOUGH_TO_READ = 1_000;

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
  /** The text behind the item under the cursor, fetched once per item. */
  const [preview, setPreview] = useState<HeldText | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previews = useRef(new Map<number, HeldText>());
  /** On a phone the pane is a sheet, opened on purpose. */
  const [sheet, setSheet] = useState(false);

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
  const current = flat[cursor] ?? null;

  // The pane follows the cursor. Cached per item, so moving back up the list
  // costs nothing, and abandoned on the next move so a slow answer for the
  // item you left cannot land on the one you are looking at.
  useEffect(() => {
    if (!current) {
      setPreview(null);
      return;
    }
    const hit = previews.current.get(current.id);
    if (hit) {
      setPreview(hit);
      return;
    }
    const ctrl = new AbortController();
    setPreviewLoading(true);
    fetch(`/api/inbox/${current.id}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<HeldText>) : null))
      .then((data) => {
        if (!data || ctrl.signal.aborted) return;
        previews.current.set(data.id, data);
        setPreview(data);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!ctrl.signal.aborted) setPreviewLoading(false);
      });
    return () => ctrl.abort();
  }, [current]);

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
        note?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "That did not work.");
      if (data.note) setError(data.note);
      if (data.items) setItems(data.items);
      if (typeof data.held === "number") setCount(data.held);
      if (data.runId) setRunId(data.runId);
      setSelected(new Set());
      setLastDiscarded(action === "discard" ? itemIds : []);
      setCursor((c) => Math.max(0, Math.min(c, (data.items?.length ?? 1) - 1)));
      for (const id of itemIds) previews.current.delete(id);
      setSheet(false);
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
      // The pane must show the new text, not the stub it cached.
      previews.current.delete(itemId);
      setPreview(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** J/K to move, Enter to keep, D to discard, P to paste, X to select, O to open. Not while typing. */
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
    else if (e.key === "o" && here?.url) window.open(here.url, "_blank", "noopener");
    else return;
    e.preventDefault();
  }

  const selectedIds = [...selected];
  const visibleIds = visible.map((i) => i.id);

  const pasteBox = (item: Item) => (
    <div className="rounded-lg border border-[var(--color-accent)]/50 bg-white p-3">
      <p className="text-xs text-[var(--color-muted)]">
        Open it where you are signed in, select the article, and paste it here. The address, outlet
        and date stay as they are — this only replaces the text.
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
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-30"
        >
          <IconClipboard /> Save the text
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
  );

  const pane = current ? (
    <Preview
      item={current}
      text={preview?.id === current.id ? preview : null}
      loading={previewLoading}
      busy={busy}
      pasting={pasting === current.id}
      pasteBox={pasting === current.id ? pasteBox(current) : null}
      onKeep={() => act("keep", [current.id])}
      onDiscard={() => act("discard", [current.id])}
      onPaste={() => {
        setPasting(pasting === current.id ? null : current.id);
        setPasted("");
      }}
    />
  ) : (
    <div className="p-6 text-sm text-[var(--color-muted)]">
      Move along the list, or hover an item, and what was fetched for it shows here — so you can
      tell an article from a paywall&apos;s stub before you keep it.
    </div>
  );

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
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-rule)] px-3 py-1.5 text-sm transition hover:border-[var(--color-accent)]"
          >
            <IconWeek /> This week
          </Link>
          <Link
            href="/feeds"
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-rule)] px-3 py-1.5 text-sm transition hover:border-[var(--color-accent)]"
          >
            <IconFeed /> Feeds
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
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white transition disabled:opacity-30"
            >
              <IconCheck /> Keep{selectedIds.length ? ` ${selectedIds.length}` : ""}
            </button>
            <button
              type="button"
              disabled={busy || !selectedIds.length}
              onClick={() => act("discard", selectedIds)}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-rule)] px-4 py-1.5 text-sm transition hover:border-red-400 hover:text-red-700 disabled:opacity-30"
            >
              <IconX /> Discard{selectedIds.length ? ` ${selectedIds.length}` : ""}
            </button>
            <span className="mx-1 h-4 w-px bg-[var(--color-rule)]" />
            <button
              type="button"
              onClick={() => setSelected(new Set(visibleIds))}
              className="inline-flex items-center gap-1 text-xs text-[var(--color-muted)] transition hover:text-[var(--color-accent)]"
            >
              <IconSelectAll size={14} /> Select all {outlet ? `from ${outlet}` : ""}
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
                className="inline-flex items-center gap-1 text-xs text-[var(--color-accent)] hover:underline"
              >
                <IconUndo size={14} /> Undo {lastDiscarded.length}
              </button>
            ) : null}
            <span className="ml-auto hidden text-xs text-[var(--color-muted)] sm:inline">
              <kbd className="rounded border border-[var(--color-rule)] px-1">j</kbd>{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">k</kbd> move ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">↵</kbd> keep ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">d</kbd> discard ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">p</kbd> paste ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">o</kbd> open
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
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(19rem,24rem)] lg:items-start lg:gap-5">
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
                        className="ml-auto inline-flex items-center gap-1 text-xs text-[var(--color-muted)] transition hover:text-[var(--color-accent)]"
                      >
                        <IconSelectAll size={14} /> Select all
                      </button>
                    </div>
                  ) : null}

                  <ul className="divide-y divide-[var(--color-rule)]">
                    {group.items.map((item) => {
                      const isCursor = current?.id === item.id;
                      const chosen = selected.has(item.id);
                      // Not "did the fetch return something" but "is there an
                      // article here": a paywalled piece arrives as its headline
                      // and a sentence, which is a citation that opens on nothing.
                      const thin = item.chars < ENOUGH_TO_READ;
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
                                    paste the article to keep it
                                  </span>
                                ) : null}
                                {item.note === "Full text pasted in." || item.note === "Full text clipped from the browser." ? (
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

                              {pasting === item.id ? <div className="mt-3 lg:hidden">{pasteBox(item)}</div> : null}

                              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-muted)]">
                                <span title={formatDateTime(item.seen_at)}>pulled {relativeDate(item.seen_at)}</span>
                                {item.chunks > 0 ? (
                                  <span>
                                    {item.chunks} passage{item.chunks === 1 ? "" : "s"}
                                  </span>
                                ) : null}
                                {item.reliability ? <span className="italic">{item.reliability}</span> : null}

                                <span className="ms-auto flex items-center gap-2.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setCursor(flat.findIndex((f) => f.id === item.id));
                                      setSheet(true);
                                    }}
                                    title="See what was fetched"
                                    className="inline-flex items-center gap-1 transition hover:text-[var(--color-accent)] lg:hidden"
                                  >
                                    <IconEye /> Preview
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => {
                                      setPasting(pasting === item.id ? null : item.id);
                                      setPasted("");
                                    }}
                                    title="Replace the text with the article, pasted from where you are signed in"
                                    className="inline-flex items-center gap-1 transition hover:text-[var(--color-accent)]"
                                  >
                                    <IconClipboard /> Paste text
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => act("discard", [item.id])}
                                    title="Not worth reading"
                                    className="inline-flex items-center gap-1 transition hover:text-red-700"
                                  >
                                    <IconX /> Discard
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy || thin}
                                    title={
                                      thin
                                        ? "There is no article behind this yet — paste it in first"
                                        : "Read it into the pedia"
                                    }
                                    onClick={() => act("keep", [item.id])}
                                    className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent)] px-3 py-1 font-medium text-white transition disabled:opacity-30"
                                  >
                                    <IconCheck /> Keep
                                  </button>
                                </span>
                              </div>
                            </div>

                            {pictureOf(item) ? <Thumb src={pictureOf(item)!} /> : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>

          {/* The pane. Sticky under the action bar; scrolls on its own. */}
          <aside className="sticky top-14 hidden max-h-[calc(100vh-4.5rem)] overflow-y-auto rounded-xl border border-[var(--color-rule)] bg-white lg:block">
            {pane}
          </aside>
        </div>
      )}

      {sheet && current ? (
        <Modal label={current.title} onClose={() => setSheet(false)} width="max-w-2xl" className="max-h-[85vh] overflow-y-auto !p-0">
          {pane}
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * Where an item's picture comes from.
 *
 * The feed's own, or the page's og:image noted when it was fetched. Items
 * from before pictures were kept have neither, so they fall back to the
 * cover route, which looks the page's picture up once and keeps it on disk —
 * the same thing the Library shelf does for every source. Lazy-loaded, so
 * only the rows on screen ask.
 */
function pictureOf(item: Item): string | null {
  if (item.image) return item.image;
  // Items from before pictures were kept still carry the feed's summary, and
  // a summary often opens with the picture. Same rule as itemImage() in
  // lib/feeds.ts, applied late.
  if (item.summary) {
    const m = /<img\b[^>]*\bsrc=["'](https?:\/\/[^"']+)["']/i.exec(item.summary);
    if (m) return m[1];
  }
  if (item.source_id) return `/api/sources/${item.source_id}/cover`;
  return null;
}

/** A picture beside the row. Gone without a trace when it will not load. */
function Thumb({ src, large = false }: { src: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={
        large
          ? "aspect-video w-full object-cover"
          : "h-[4.5rem] w-28 shrink-0 self-start rounded-md object-cover ring-1 ring-black/10"
      }
    />
  );
}

/**
 * What was fetched for one item, and whether it is enough.
 *
 * The verdict comes from the server under the same rule keep() applies, so
 * the pane can never say "enough" about something the keep would refuse.
 */
function Preview({
  item,
  text,
  loading,
  busy,
  pasting,
  pasteBox,
  onKeep,
  onDiscard,
  onPaste,
}: {
  item: Item;
  text: HeldText | null;
  loading: boolean;
  busy: boolean;
  pasting: boolean;
  pasteBox: React.ReactNode;
  onKeep: () => void;
  onDiscard: () => void;
  onPaste: () => void;
}) {
  const verdict = text?.verdict ?? (item.chars < ENOUGH_TO_READ ? "thin" : "enough");
  const body = text ? text.passages.map((p) => p.text).join("\n\n") : "";
  return (
    <div>
      {pictureOf(item) ? <Thumb src={pictureOf(item)!} large /> : null}
      <div className="space-y-3 p-4">
        <div>
          <h2 className="font-serif text-lg font-semibold leading-snug">
            {item.url ? (
              <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-[var(--color-accent)]">
                {item.title} <IconExternal size={14} className="inline align-baseline opacity-60" />
              </a>
            ) : (
              item.title
            )}
          </h2>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            {item.outlet ?? item.feed_title}
            {item.published_at ? ` · ${formatDateTime(item.published_at)}` : ""}
          </p>
        </div>

        {verdict === "enough" ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            <IconCheck className="mr-1 inline align-[-2px]" />
            Enough to read
            {text ? ` — ${text.words.toLocaleString()} words in ${text.passages.length} passage${text.passages.length === 1 ? "" : "s"}` : ""}
            . Keeping it reads all of this.
          </p>
        ) : verdict === "summary" ? (
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <IconText className="mr-1 inline align-[-2px]" />
            Only the feed&apos;s summary is here — the page would not open. Paste the article to keep
            it.
          </p>
        ) : (
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <IconText className="mr-1 inline align-[-2px]" />
            Too little to be an article
            {text ? ` — ${text.words.toLocaleString()} words` : ""}. Paste the article to keep it.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || verdict !== "enough"}
            onClick={onKeep}
            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white transition disabled:opacity-30"
          >
            <IconCheck /> Keep
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDiscard}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-rule)] px-3 py-1.5 text-sm transition hover:border-red-400 hover:text-red-700 disabled:opacity-30"
          >
            <IconX /> Discard
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onPaste}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-30 ${
              pasting ? "border-[var(--color-accent)] text-[var(--color-accent)]" : "border-[var(--color-rule)] hover:border-[var(--color-accent)]"
            }`}
          >
            <IconClipboard /> Paste text
          </button>
        </div>

        {pasteBox ? <div className="hidden lg:block">{pasteBox}</div> : null}

        {text?.source_note ? (
          <p className="text-xs italic text-[var(--color-muted)]">{text.source_note}</p>
        ) : null}

        {loading && !text ? (
          <p className="text-sm text-[var(--color-muted)]">Opening…</p>
        ) : body ? (
          <div
            dir={dirOf(body)}
            className="whitespace-pre-wrap border-t border-[var(--color-rule)] pt-3 font-serif text-[0.95rem] leading-relaxed"
          >
            {body}
          </div>
        ) : text ? (
          <p className="text-sm text-[var(--color-muted)]">Nothing was fetched for this item.</p>
        ) : null}
      </div>
    </div>
  );
}
