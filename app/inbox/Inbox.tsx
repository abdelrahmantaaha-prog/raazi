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
  IconFind,
  IconSelectAll,
  IconShelf,
  IconStar,
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
  clipped_at: string | null;
  starred: number;
}

interface Group {
  key: string;
  title: string;
  storyId: number | null;
  items: Item[];
}

type PaneView = "text" | "page";
const VIEW_KEY = "corpus.inbox.view";

/** The latest moment anything in a group was sent from the browser, or "". */
const latestClip = (g: Group) =>
  g.items.reduce((last, i) => (i.clipped_at && i.clipped_at > last ? i.clipped_at : last), "");

/**
 * The inbox: everything the feeds pulled in, waiting on a yes or a no.
 *
 * This page is the only place the reading pipeline starts, so it is built for
 * going fast rather than for looking at. Three things do that work.
 *
 * Grouping by story, so five accounts of one thing are one decision. What you
 * sent from the browser at the top, because you sent it on purpose — and it
 * arrives there by itself, without a reload.
 * And a keyboard: J and K move, Enter keeps, D discards, P opens the paste box,
 * so a hundred items is a rhythm rather than a hundred trips to the mouse.
 *
 * On a wide screen the item you click (or move to with J and K) opens in a
 * pane on the right:
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
  stamp,
  reviewOn,
}: {
  initial: Item[];
  held: number;
  /** The clip stamp the list was read at; see clipStamp() in lib/triage.ts. */
  stamp: string;
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
  const [pasting, setPasting] = useState<number | null>(null);
  const [pasted, setPasted] = useState("");
  /**
   * The item in the pane, by id rather than by position. The list can gain a
   * clip at the top or lose the row you just discarded, and the pane should
   * stay on the article you are reading, not on whatever now sits at its index.
   * Null until you pick one, which shows the first.
   */
  const [currentId, setCurrentId] = useState<number | null>(null);
  /**
   * What the pane shows: the text the fetch got, or the article's own page,
   * live. Remembered in this browser, and read after the first render so the
   * server's page and the browser's agree.
   */
  const [view, setView] = useState<PaneView>("text");
  useEffect(() => {
    try {
      if (localStorage.getItem(VIEW_KEY) === "page") setView("page");
    } catch {
      /* storage blocked: the text view it is */
    }
  }, []);
  const chooseView = (next: PaneView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* remembered for this visit only */
    }
  };
  /** The text behind the item under the cursor, fetched once per item. */
  const [preview, setPreview] = useState<HeldText | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previews = useRef(new Map<number, HeldText>());
  /** On a phone the pane is a sheet, opened on purpose. */
  const [sheet, setSheet] = useState(false);

  /**
   * A search of the inbox. `query` is what is typed; `searched` is what the list
   * on screen is the answer to, which is also what every action and refresh
   * sends back so the list they return is still that search.
   */
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [searching, setSearching] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);

  // Asked a moment after typing stops, and the answer to an older query is
  // thrown away when a newer one is on its way. Clearing the box asks at once.
  useEffect(() => {
    const q = query.trim();
    if (q === searched) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(q ? `/api/inbox?q=${encodeURIComponent(q)}` : "/api/inbox", {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error("The search did not work.");
        const data = (await res.json()) as { items: Item[]; held: number };
        setSearching(false);
        setItems(data.items);
        setCount(data.held);
        // A selection made before the search could hide rows the buttons would act on.
        setSelected(new Set());
        setSearched(q);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setSearching(false);
        setError((err as Error).message);
      }
    }, q ? 250 : 0);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [query, searched]);

  // "/" puts you in the search box from anywhere on the page, unless you are typing.
  useEffect(() => {
    const onSlash = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      searchBox.current?.focus();
      searchBox.current?.select();
    };
    window.addEventListener("keydown", onSlash);
    return () => window.removeEventListener("keydown", onSlash);
  }, []);

  const searchWords = useMemo(
    () => searched.toLowerCase().split(/\s+/).map((w) => w.replace(/"/g, "")).filter(Boolean),
    [searched]
  );
  /** Found by its article text alone: nothing the row shows explains the match, so the row says where it was. */
  const foundInText = (item: Item) => {
    if (!searchWords.length) return false;
    const shown = [item.title, item.outlet, item.feed_title, item.lede, item.summary]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return !searchWords.every((w) => shown.includes(w));
  };

  /**
   * Where each story sits in the list, fixed the first time it is seen.
   *
   * The list used to be re-sorted by size on every change, so discarding one
   * account of a story could move its whole group and the rows under the
   * pointer changed. A story now keeps its place for as long as the page is
   * open: something new goes to the bottom, and anything the extension has
   * just sent goes to the very top.
   */
  const ranks = useRef(new Map<string, number>());
  /** The clip time last seen for each item, to tell a fresh clip from an old one. */
  const clipsSeen = useRef(new Map<number, string>());

  /** Grouped by story, so duplicates arrive as one decision. */
  const groups = useMemo(() => {
    const byStory = new Map<string, Group>();
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
    const all = [...byStory.values()];
    const rank = ranks.current;

    // What the page opens on: clips first, the latest clip first, then the
    // biggest stories. The sort is stable, so ties keep the server's order.
    const opening = [...all].sort(
      (a, b) => latestClip(b).localeCompare(latestClip(a)) || b.items.length - a.items.length
    );
    if (rank.size === 0) {
      opening.forEach((g, i) => rank.set(g.key, i));
    } else {
      let top = Math.min(...rank.values());
      let bottom = Math.max(...rank.values());
      // Oldest clip first, so the most recent one is what ends up on top.
      const clipped = all
        .filter((g) => g.items.some((i) => i.clipped_at !== null && clipsSeen.current.get(i.id) !== i.clipped_at))
        .sort((a, b) => latestClip(a).localeCompare(latestClip(b)));
      for (const g of clipped) rank.set(g.key, --top);
      for (const g of opening) if (!rank.has(g.key)) rank.set(g.key, ++bottom);
    }
    for (const i of items) if (i.clipped_at) clipsSeen.current.set(i.id, i.clipped_at);

    return all.sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  }, [items]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const cursor = Math.max(0, flat.findIndex((f) => f.id === currentId));
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

  // Its neighbours too, quietly, so a discard — or J and K — lands on text
  // that is already here, and the pane changes in one step instead of going
  // blank while the next article loads.
  const fetching = useRef(new Set<number>());
  useEffect(() => {
    for (const next of [flat[cursor + 1], flat[cursor - 1]]) {
      if (!next || previews.current.has(next.id) || fetching.current.has(next.id)) continue;
      fetching.current.add(next.id);
      fetch(`/api/inbox/${next.id}`)
        .then((r) => (r.ok ? (r.json() as Promise<HeldText>) : null))
        .then((data) => {
          if (data) previews.current.set(data.id, data);
        })
        .catch(() => undefined)
        .finally(() => fetching.current.delete(next.id));
    }
  }, [flat, cursor]);

  // A new article opens at its top, not wherever the last one was scrolled to.
  const paneBox = useRef<HTMLElement>(null);
  const shownId = current?.id ?? null;
  useEffect(() => {
    paneBox.current?.scrollTo({ top: 0 });
  }, [shownId]);

  // What the extension sends appears without a reload. The stamp moves only
  // when something is clipped — not when a feed brings in the day's items — so
  // the list never rearranges itself under you for anything you did not send.
  // Checked every few seconds while the page is in front, and at once when you
  // come back to it from the tab you clipped in.
  const latest = useRef({ items, busy, searched });
  useEffect(() => {
    latest.current = { items, busy, searched };
  });
  const seenStamp = useRef(stamp);
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (document.hidden || latest.current.busy) return;
      try {
        const res = await fetch("/api/inbox?stamp=1", { cache: "no-store" });
        if (!res.ok) return;
        const now = ((await res.json()) as { stamp: string }).stamp;
        if (now === seenStamp.current) return;

        const q = latest.current.searched;
        const list = await fetch(q ? `/api/inbox?q=${encodeURIComponent(q)}` : "/api/inbox", { cache: "no-store" });
        if (!list.ok || stopped || latest.current.busy) return;
        const data = (await list.json()) as { items: Item[]; held: number };
        // A clip onto an item already here replaced its text: forget the stub
        // the pane cached, so it shows the article.
        const before = new Map(latest.current.items.map((i) => [i.id, i.clipped_at]));
        for (const i of data.items) {
          if (i.clipped_at && before.get(i.id) !== i.clipped_at) previews.current.delete(i.id);
        }
        seenStamp.current = now;
        setItems(data.items);
        setCount(data.held);
      } catch {
        /* the next check tries again */
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 4000);
    const onBack = () => void check();
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("focus", onBack);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("focus", onBack);
    };
  }, []);

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

  async function act(action: "keep" | "file" | "discard" | "undo", itemIds: number[]) {
    if (!itemIds.length) return;
    // Where the pane goes when the item it shows is the one being decided: the
    // next one down that is not going too, or failing that the nearest above.
    const going = new Set(itemIds);
    const shown = current?.id ?? null;
    const successor =
      shown !== null && going.has(shown)
        ? ((flat.slice(cursor + 1).find((i) => !going.has(i.id)) ??
            flat.slice(0, cursor).reverse().find((i) => !going.has(i.id)))?.id ?? null)
        : shown;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, itemIds, q: searched || undefined }),
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
      if (data.items) {
        setItems(data.items);
        // A refused keep leaves the item where it is, and the pane with it.
        setCurrentId(data.items.some((i) => i.id === shown) ? shown : successor);
      }
      if (typeof data.held === "number") setCount(data.held);
      if (data.runId) setRunId(data.runId);
      setSelected(new Set());
      setLastDiscarded(action === "discard" ? itemIds : []);
      for (const id of itemIds) previews.current.delete(id);
      setSheet(false);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Stars or unstars an item's article. A mark, not a decision: the item stays
   * in the inbox, and the Write page's Starred tab keeps the article for a
   * closer look whatever you decide here. Shown at once and put back if the
   * save fails.
   */
  async function star(item: Item) {
    if (item.source_id === null) return;
    const on = !item.starred;
    const show = (value: number) =>
      setItems((all) => all.map((i) => (i.id === item.id ? { ...i, starred: value } : i)));
    show(on ? 1 : 0);
    try {
      const res = await fetch("/api/starred", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: item.source_id, starred: on }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "The star did not save.");
      }
    } catch (err) {
      show(on ? 0 : 1);
      setError((err as Error).message);
    }
  }

  async function savePaste(itemId: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "paste", itemIds: [itemId], text: pasted, q: searched || undefined }),
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

  /** J/K to move, Enter to keep, F to file, D to discard, S to star, P to paste, X to select, O to open. Not while typing. */
  function onKey(e: React.KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || pasting !== null) return;
    const here = flat[cursor];
    if (e.key === "j") setCurrentId(flat[Math.min(cursor + 1, flat.length - 1)]?.id ?? null);
    else if (e.key === "k") setCurrentId(flat[Math.max(cursor - 1, 0)]?.id ?? null);
    else if (e.key === "Enter" && here) void act("keep", [here.id]);
    else if (e.key === "f" && here) void act("file", [here.id]);
    else if (e.key === "d" && here) void act("discard", [here.id]);
    else if (e.key === "s" && here) void star(here);
    else if (e.key === "v" && here?.url) chooseView(view === "page" ? "text" : "page");
    else if (e.key === "p" && here) {
      setPasting(here.id);
      setPasted("");
    } else if (e.key === "x" && here) toggle(here.id);
    else if (e.key === "o" && here?.url) window.open(here.url, "_blank", "noopener");
    else return;
    e.preventDefault();
  }

  const selectedIds = [...selected];
  const visibleIds = items.map((i) => i.id);

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
      onFile={() => act("file", [current.id])}
      onDiscard={() => act("discard", [current.id])}
      starred={Boolean(current.starred)}
      onStar={() => void star(current)}
      view={view}
      onView={chooseView}
      onPaste={() => {
        setPasting(pasting === current.id ? null : current.id);
        setPasted("");
      }}
    />
  ) : (
    <div className="p-6 text-sm text-[var(--color-muted)]">
      Click an item, or move along the list with J and K, and what was fetched for it shows here —
      so you can tell an article from a paywall&apos;s stub before you keep it.
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
            href="/write?tab=starred"
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-rule)] px-3 py-1.5 text-sm transition hover:border-[var(--color-accent)]"
          >
            <IconStar /> Starred
          </Link>
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

      {/* Out of the page's flow: a message arriving or clearing used to push
          the whole list up or down under the pointer. */}
      {error ? (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 z-40 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-900 shadow-lg sm:max-w-xl"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss"
            className="mt-0.5 shrink-0 opacity-60 transition hover:opacity-100"
          >
            <IconX size={14} />
          </button>
        </div>
      ) : null}

      {items.length > 0 || searched ? (
        <>
          {/* The action bar follows you down the page. The outlet chips that
              sat above it are gone: a chip vanishing when its last item was
              decided reflowed the row and moved the list. */}
          <div className="sticky top-0 z-20 -mx-2 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-rule)] bg-white/85 px-3 py-2 backdrop-blur">
            <label className="relative flex min-w-[12rem] flex-1 basis-56 items-center sm:max-w-xs">
              <IconFind size={14} className="pointer-events-none absolute start-2.5 text-[var(--color-muted)]" />
              <input
                ref={searchBox}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setQuery("");
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Search the inbox"
                aria-label="Search the inbox — headlines, outlets and article text"
                title="Headlines, outlets and the article text. / to jump here, Esc to clear."
                className="w-full rounded-full border border-[var(--color-rule)] bg-white py-1 pe-20 ps-7 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              {query.trim() ? (
                <span className="pointer-events-none absolute end-3 text-[11px] text-[var(--color-muted)]">
                  {searching || query.trim() !== searched
                    ? "searching…"
                    : `${items.length}${items.length >= 200 ? "+" : ""} found`}
                </span>
              ) : null}
            </label>
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
              onClick={() => act("file", selectedIds)}
              title="Read into the library, but leave out of the brief"
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-accent)]/50 px-4 py-1.5 text-sm text-[var(--color-accent)] transition hover:bg-[var(--color-accent-soft)] disabled:opacity-30"
            >
              <IconShelf /> File{selectedIds.length ? ` ${selectedIds.length}` : ""}
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
              <IconSelectAll size={14} /> Select all{searched ? " found" : ""}
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
              <kbd className="rounded border border-[var(--color-rule)] px-1">/</kbd> search ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">j</kbd>{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">k</kbd> move ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">↵</kbd> keep ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">f</kbd> file ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">d</kbd> discard ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">s</kbd> star ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">p</kbd> paste ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">v</kbd> page ·{" "}
              <kbd className="rounded border border-[var(--color-rule)] px-1">o</kbd> open
            </span>
          </div>
        </>
      ) : null}

      {items.length === 0 && searched ? (
        <div className="rounded-xl border border-dashed border-[var(--color-rule)] px-6 py-16 text-center">
          <p className="font-serif text-xl">Nothing in the inbox matches “{searched}”</p>
          <p className="mx-auto mt-2 max-w-[46ch] text-sm text-[var(--color-muted)]">
            Headlines, outlets and the text of every article waiting here were searched.{" "}
            <button type="button" onClick={() => setQuery("")} className="underline hover:text-[var(--color-accent)]">
              Clear the search
            </button>
          </p>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-rule)] px-6 py-16 text-center">
          <p className="font-serif text-xl">Nothing waiting</p>
          <p className="mx-auto mt-2 max-w-[46ch] text-sm text-[var(--color-muted)]">
            The feeds check themselves on their own schedule while Corpus is open. What they bring in
            lands here first, and waits.
          </p>
        </div>
      ) : (
        // Half and half once there is room for it: the pane is where an item is
        // actually read, and a 24rem column made that a scroll through a narrow
        // strip. Below xl the page leaves under 800px beside the sidebar, and
        // halving that squeezes the rows until their buttons wrap, so the list
        // keeps the larger share there.
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(19rem,24rem)] lg:items-start lg:gap-5 xl:grid-cols-2">
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
                          // A click on the row, not a hover: the pane used to
                          // follow the mouse, which meant reading it while
                          // moving to a button changed what it showed. The
                          // row's own links, buttons and checkbox keep their
                          // clicks; anywhere else on the row picks the item.
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest("a, button, input, textarea, label")) return;
                            setCurrentId(item.id);
                          }}
                          className={`group relative cursor-pointer px-4 py-3 transition ${
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
                                {item.starred ? (
                                  <span title="Starred — on the Write page's Starred tab" className="self-center text-amber-500">
                                    <IconStar size={13} fill="currentColor" />
                                  </span>
                                ) : null}
                                <span className="text-xs text-[var(--color-muted)]">
                                  {item.outlet ?? item.feed_title}
                                  {item.published_at ? ` · ${relativeDate(item.published_at)}` : ""}
                                </span>
                                {foundInText(item) ? (
                                  <span
                                    title="The words are in the article's text rather than the headline"
                                    className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] text-sky-800"
                                  >
                                    found in the text
                                  </span>
                                ) : null}
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
                                      setCurrentId(item.id);
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
                                    disabled={item.source_id === null}
                                    onClick={() => void star(item)}
                                    title={item.starred ? "Unstar" : "Star it for a closer look — listed on the Write page"}
                                    className={`inline-flex items-center gap-1 transition hover:text-amber-600 disabled:opacity-30 ${
                                      item.starred ? "text-amber-600" : ""
                                    }`}
                                  >
                                    <IconStar fill={item.starred ? "currentColor" : "none"} /> {item.starred ? "Starred" : "Star"}
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
                                    onClick={() => act("file", [item.id])}
                                    title={
                                      thin
                                        ? "There is no article behind this yet — paste it in first"
                                        : "Read it into the library, but keep it out of the brief"
                                    }
                                    className="inline-flex items-center gap-1 transition hover:text-[var(--color-accent)] disabled:opacity-30"
                                  >
                                    <IconShelf /> File
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

          {/* The pane. Sticky under the action bar; scrolls on its own. One
              fixed height, so it does not shrink and regrow between articles. */}
          <aside
            ref={paneBox}
            className="sticky top-14 hidden h-[calc(100vh-4.5rem)] overflow-y-auto rounded-xl border border-[var(--color-rule)] bg-white lg:block"
          >
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

/**
 * The article's own page, live, inside the pane.
 *
 * Nearly every news site refuses to be shown inside another page, and says so
 * in a header the browser obeys; the Corpus Inbox extension (0.3.0 and later)
 * removes that header for frames Corpus opens, and for nothing else. Without
 * it the frame stays blank, which is why the way out is always under it.
 *
 * The sandbox leaves out top navigation, so a page that tries to break out of
 * its frame cannot carry Corpus away with it.
 */
function PageView({ url }: { url: string }) {
  return (
    <div className="space-y-1.5 border-t border-[var(--color-rule)] pt-3">
      <iframe
        key={url}
        src={url}
        title="The article's own page"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation"
        referrerPolicy="no-referrer"
        className="h-[calc(100vh-17rem)] min-h-[24rem] w-full rounded-lg border border-[var(--color-rule)] bg-white"
      />
      <p className="text-[11px] leading-snug text-[var(--color-muted)]">
        Blank? The site refuses to be shown inside another page — the Corpus Inbox extension lifts that from
        version 0.3.0 — or{" "}
        <a href={url} target="_blank" rel="noreferrer" className="underline hover:text-[var(--color-accent)]">
          open it in a tab
        </a>
        . Signed out? Brave keeps your logins from pages inside another site; allow cross-site cookies for
        Corpus in Shields. The extension&apos;s icon sends the article shown here.
      </p>
    </div>
  );
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
          ? // A fixed height rather than a ratio: the space is held before the
            // picture arrives, so the text does not drop when it loads, and at
            // half the page a 16:9 picture stood over 300px tall.
            "h-56 w-full object-cover"
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
  onFile,
  onDiscard,
  onPaste,
  starred,
  onStar,
  view,
  onView,
}: {
  item: Item;
  text: HeldText | null;
  loading: boolean;
  busy: boolean;
  pasting: boolean;
  pasteBox: React.ReactNode;
  onKeep: () => void;
  onFile: () => void;
  onDiscard: () => void;
  onPaste: () => void;
  starred: boolean;
  onStar: () => void;
  view: PaneView;
  onView: (view: PaneView) => void;
}) {
  const verdict = text?.verdict ?? (item.chars < ENOUGH_TO_READ ? "thin" : "enough");
  const body = text ? text.passages.map((p) => p.text).join("\n\n") : "";
  return (
    <div>
      {view === "text" && pictureOf(item) ? <Thumb src={pictureOf(item)!} large /> : null}
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

        {item.url ? (
          <div role="tablist" aria-label="What the pane shows" className="inline-flex rounded-full border border-[var(--color-rule)] p-0.5 text-xs">
            {(["text", "page"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => onView(v)}
                title={v === "text" ? "The text Corpus fetched (V)" : "The article's own page, live, inside Corpus (V)"}
                className={`rounded-full px-3 py-1 transition ${
                  view === v ? "bg-[var(--color-ink)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                }`}
              >
                {v === "text" ? "Fetched text" : "Page"}
              </button>
            ))}
          </div>
        ) : null}

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
            disabled={busy || verdict !== "enough"}
            onClick={onFile}
            title="Read it into the library, but keep it out of the brief — for the piece that belongs in the pedia and not in the morning"
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-accent)]/50 px-3 py-1.5 text-sm text-[var(--color-accent)] transition hover:bg-[var(--color-accent-soft)] disabled:opacity-30"
          >
            <IconShelf /> File
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
            disabled={item.source_id === null}
            onClick={onStar}
            title={starred ? "Unstar" : "Star it for a closer look — listed on the Write page, whatever you decide here"}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-30 ${
              starred
                ? "border-amber-400 bg-amber-50 text-amber-700"
                : "border-[var(--color-rule)] hover:border-amber-400 hover:text-amber-700"
            }`}
          >
            <IconStar fill={starred ? "currentColor" : "none"} /> {starred ? "Starred" : "Star"}
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

        {view === "page" && item.url ? (
          <PageView url={item.url} />
        ) : loading && !text ? (
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
