"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDateTime, relativeDate } from "@/lib/dates";
import { ArticleLink } from "../components/ArticleLink";

interface FeedRow {
  id: number;
  url: string;
  title: string;
  outlet: string | null;
  kind: string;
  reliability: string | null;
  enabled: boolean;
  intervalMinutes: number;
  dailyCap: number;
  lastPolledAt: string | null;
  lastStatus: string | null;
  items: number;
  ready: number;
  pending: number;
  /** What your decisions say about this feed; see lib/curator.ts. */
  standing: "earning" | "quiet" | "noise";
  standingNote: string | null;
  effectiveCap: number;
  setAside: number;
  putBack: number;
  tagIds: number[];
}

/**
 * Where a beat is configured.
 *
 * Two ways in, because they are genuinely different jobs: a feed you know the
 * address of (an outlet's politics page, a committee, a wire) and a phrase you
 * want watched wherever it turns up, which becomes a news-query feed. Both end
 * up as the same row.
 *
 * The two numbers that matter are on every row rather than behind a settings
 * panel: how often it is checked, and the most it may bring in a day. A feed
 * that runs away with your quota is the failure mode, and it should be visible
 * and one click from fixed.
 */
export function FeedsManager({
  feeds,
  tags,
  recent,
}: {
  feeds: FeedRow[];
  tags: { id: number; name: string }[];
  recent: {
    id: number;
    title: string;
    state: string;
    note: string | null;
    published_at: string | null;
    source_id: number | null;
    feed: string;
  }[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"url" | "phrase">("url");
  const [value, setValue] = useState("");
  const [chosen, setChosen] = useState<number[]>([]);
  const [includeExisting, setIncludeExisting] = useState(false);
  /** For a page with no feed: part of the address every article shares. */
  const [linkPattern, setLinkPattern] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return feeds;
    return feeds.filter((f) =>
      [f.title, f.outlet, f.url, f.reliability].some((v) => (v ?? "").toLowerCase().includes(q))
    );
  }, [feeds, filter]);
  const paused = feeds.filter((f) => !f.enabled).length;
  const ceiling = feeds.reduce((n, f) => n + (f.enabled ? f.dailyCap : 0), 0);

  async function post(url: string, body: unknown, method = "POST") {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "DELETE" ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; note?: string };
    if (!res.ok) throw new Error(data.error ?? "That did not work.");
    return data;
  }

  async function add() {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const data = (await post("/api/feeds", {
        action: mode === "phrase" ? "watchPhrase" : "add",
        url: mode === "url" ? value.trim() : undefined,
        phrase: mode === "phrase" ? value.trim() : undefined,
        tags: chosen,
        includeExisting,
        linkPattern: mode === "url" && linkPattern.trim() ? linkPattern.trim() : undefined,
      })) as { title?: string; items?: number; kind?: string };
      setValue("");
      setChosen([]);
      setLinkPattern("");
      setNote(
        data.kind === "page"
          ? `Watching the page "${data.title}" — ${data.items ?? 0} link(s) on it now${
              includeExisting ? ", all queued to read" : ", recorded as seen; whatever appears next arrives in the inbox"
            }.`
          : data.title
            ? `Following "${data.title}"${data.items ? ` — it is carrying ${data.items} item(s) right now.` : "."}`
            : "Added."
      );
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(id: number, body: unknown, method = "POST") {
    setError(null);
    try {
      await post(`/api/feeds/${id}`, body, method);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function checkAll() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const data = (await post("/api/feeds", { action: "pollNow" })) as { note?: string; feeds?: number };
      setNote(data.note ?? `Checking ${data.feeds ?? 0} feed(s) now.`);
      router.refresh();
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
          <h1 className="font-serif text-2xl font-semibold">Feeds</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            The places your beat comes from. Each one is read on its own schedule, filed under the topics you
            choose, and capped so a republished archive cannot run away with the day.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={checkAll}
            disabled={busy || feeds.length === 0}
            className="rounded border border-[var(--color-rule)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)] disabled:opacity-50"
          >
            Check now
          </button>
          <Link
            href="/brief"
            className="rounded border border-[var(--color-rule)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)]"
          >
            The brief
          </Link>
        </div>
      </header>

      <section className="rounded border border-[var(--color-rule)] p-4">
        <div className="flex gap-4 text-sm">
          {(["url", "phrase"] as const).map((m) => (
            <label key={m} className="flex items-center gap-1.5">
              <input type="radio" checked={mode === m} onChange={() => setMode(m)} />
              {m === "url" ? "A feed address" : "A phrase to watch"}
            </label>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            placeholder={
              mode === "url"
                ? "https://www.theglobeandmail.com/politics/rss/ — a YouTube channel, or any page with no feed"
                : "softwood lumber tariff"
            }
            className="min-w-0 flex-1 rounded border border-[var(--color-rule)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <button
            type="button"
            onClick={add}
            disabled={busy || !value.trim()}
            className="rounded bg-[var(--color-accent)] px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            {busy ? "Checking…" : "Follow"}
          </button>
        </div>

        {mode === "url" ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-[var(--color-muted)]">If it is a page with no feed, only links containing:</span>
            <input
              value={linkPattern}
              onChange={(e) => setLinkPattern(e.target.value)}
              placeholder="optional — e.g. ArticleID/  or  /news\/\d+/"
              spellCheck={false}
              className="min-w-[16rem] rounded border border-[var(--color-rule)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <span className="text-xs text-[var(--color-muted)]">
              Leave it empty and Corpus takes the links that read as headlines.
            </span>
          </div>
        ) : null}

        {tags.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-[var(--color-muted)]">File under:</span>
            {tags.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() =>
                  setChosen((c) => (c.includes(t.id) ? c.filter((x) => x !== t.id) : [...c, t.id]))
                }
                className={`rounded-full border px-2 py-0.5 ${
                  chosen.includes(t.id)
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                    : "border-[var(--color-rule)]"
                }`}
              >
                {t.name}
              </button>
            ))}
          </div>
        ) : null}

        <label className="mt-3 flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <input
            type="checkbox"
            checked={includeExisting}
            onChange={(e) => setIncludeExisting(e.target.checked)}
          />
          Read what it is already carrying, not only what comes next
        </label>

        {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
        {note ? <p className="mt-2 text-sm text-[var(--color-accent)]">{note}</p> : null}
      </section>

      {feeds.length === 0 ? (
        <p className="rounded border border-dashed border-[var(--color-rule)] px-4 py-6 text-sm text-[var(--color-muted)]">
          No feeds yet. Start with a wire, a national daily, one government newsroom, and a phrase for the story
          you are chasing.
        </p>
      ) : (
        <>
          {/* Sixty feeds is a list you search rather than scroll. */}
          <div className="flex flex-wrap items-center gap-3">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name, outlet or address"
              className="min-w-[14rem] flex-1 rounded border border-[var(--color-rule)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <span className="text-sm text-[var(--color-muted)]">
              {shown.length === feeds.length
                ? `${feeds.length} feeds`
                : `${shown.length} of ${feeds.length}`}
              {paused > 0 ? ` · ${paused} paused` : ""} · ceiling {ceiling} items a day
            </span>
          </div>

          <ul className="space-y-3">
            {shown.map((f) => (
            <li key={f.id} className="rounded border border-[var(--color-rule)] p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{f.title}</span>
                    {!f.enabled ? (
                      <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">paused</span>
                    ) : null}
                    <span className="text-xs text-[var(--color-muted)]">{f.kind}</span>
                  </div>
                  <ArticleLink href={f.url}
                    className="block truncate text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]"
                  >
                    {f.url}
                  </ArticleLink>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {f.ready} read, {f.pending} waiting, {f.items} offered ·{" "}
                    {f.lastPolledAt ? `checked ${relativeDate(f.lastPolledAt)}` : "never checked"}
                    {f.lastStatus ? ` — ${f.lastStatus}` : ""}
                  </p>
                  {f.standingNote || f.setAside ? (
                    <p
                      className={`mt-1 text-xs ${f.standing === "noise" ? "text-amber-800" : "text-[var(--color-muted)]"}`}
                      title="Learned from what you kept and discarded. Keeping one item from this feed, or putting back one that was set aside, changes it."
                    >
                      {f.standingNote ?? ""}
                      {f.setAside
                        ? `${f.standingNote ? " · " : ""}${f.setAside} set aside on your pattern${f.putBack ? `, ${f.putBack} put back` : ""}`
                        : ""}
                    </p>
                  ) : null}
                  {f.tagIds.length ? (
                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      Filed under {f.tagIds.map((id) => tags.find((t) => t.id === id)?.name).filter(Boolean).join(", ")}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
                    every
                    <input
                      type="number"
                      min={5}
                      max={1440}
                      defaultValue={f.intervalMinutes}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (v !== f.intervalMinutes && v >= 5) act(f.id, { intervalMinutes: v });
                      }}
                      className="w-16 rounded border border-[var(--color-rule)] px-1 py-0.5 text-right"
                    />
                    min
                  </label>
                  <label className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
                    max
                    <input
                      type="number"
                      min={1}
                      max={500}
                      defaultValue={f.dailyCap}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (v !== f.dailyCap && v >= 1) act(f.id, { dailyCap: v });
                      }}
                      className="w-16 rounded border border-[var(--color-rule)] px-1 py-0.5 text-right"
                    />
                    a day
                  </label>
                  <button
                    type="button"
                    onClick={() => act(f.id, { action: "poll" })}
                    className="rounded border border-[var(--color-rule)] px-2 py-1 text-xs hover:border-[var(--color-accent)]"
                  >
                    Check
                  </button>
                  <button
                    type="button"
                    onClick={() => act(f.id, { enabled: !f.enabled })}
                    className="rounded border border-[var(--color-rule)] px-2 py-1 text-xs hover:border-[var(--color-accent)]"
                  >
                    {f.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      // Everything else on this row is reversible; this is not,
                      // and a list of sixty is a list you misclick in.
                      const sure = window.confirm(
                        `Stop following "${f.title}"? What it has already brought in stays in the library.`
                      );
                      if (sure) act(f.id, null, "DELETE");
                    }}
                    className="rounded border border-[var(--color-rule)] px-2 py-1 text-xs text-red-700 hover:border-red-400"
                  >
                    Remove
                  </button>
                </div>
              </div>

              <input
                defaultValue={f.reliability ?? ""}
                onBlur={(e) => {
                  if (e.target.value !== (f.reliability ?? "")) act(f.id, { reliability: e.target.value });
                }}
                placeholder="How far to trust this outlet — shown beside every citation from it"
                className="mt-2 w-full rounded border border-dashed border-[var(--color-rule)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
              />
              </li>
            ))}
          </ul>
        </>
      )}

      {recent.length > 0 ? (
        <section>
          <h2 className="font-serif text-lg font-semibold">Lately</h2>
          <ul className="mt-2 divide-y divide-[var(--color-rule)] text-sm">
            {recent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                <span className="min-w-0">
                  {r.source_id ? (
                    <Link href={`/sources/${r.source_id}`} className="hover:text-[var(--color-accent)]">
                      {r.title}
                    </Link>
                  ) : (
                    r.title
                  )}
                  <span className="ml-2 text-xs text-[var(--color-muted)]">{r.feed}</span>
                </span>
                <span className="text-xs text-[var(--color-muted)]">
                  {r.state === "ready" ? "read" : r.state}
                  {r.note && r.state !== "ready" ? ` — ${r.note}` : ""}
                  {r.published_at ? ` · ${formatDateTime(r.published_at)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
