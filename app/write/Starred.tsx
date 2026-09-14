"use client";

import { useState } from "react";
import Link from "next/link";
import { IconCheck, IconExternal, IconShelf, IconStar } from "../components/Icons";
import { formatDateTime, relativeDate } from "@/lib/dates";
import { dirOf } from "@/lib/dir";
// Types only — erased at compile time, so the database module stays out of the bundle.
import type { StarredArticle } from "@/lib/starred";

/** Matches ENOUGH_TO_READ in lib/triage.ts: below this an item cannot be kept. */
const ENOUGH_TO_READ = 1_000;

const STATE: Record<string, { label: string; tone: string }> = {
  held: { label: "waiting in the inbox", tone: "bg-sky-50 text-sky-800" },
  kept: { label: "kept", tone: "bg-emerald-50 text-emerald-800" },
  filed: { label: "filed", tone: "bg-emerald-50 text-emerald-800" },
  discarded: { label: "discarded", tone: "bg-stone-100 text-stone-600" },
};

/**
 * Articles starred in the inbox, beside the drafts, for a closer look.
 *
 * A star is not a decision, so each article says where it stands — still
 * waiting, kept, filed, or discarded — and one still waiting can be kept or
 * filed from here once you have read it. Reading opens the source's own page,
 * where a passage can be selected and sent to a draft.
 */
export function Starred({ initial }: { initial: StarredArticle[] }) {
  const [articles, setArticles] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(url: string, body: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; note?: string };
      if (!res.ok) throw new Error(data.error ?? "That did not work.");
      if (data.note) setMessage(data.note);
      const list = await fetch("/api/starred", { cache: "no-store" });
      if (list.ok) setArticles(((await list.json()) as { starred: StarredArticle[] }).starred);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (articles.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-rule)] px-6 py-14 text-center">
        <p className="font-serif text-xl">Nothing starred</p>
        <p className="mx-auto mt-2 max-w-[48ch] text-sm text-[var(--color-muted)]">
          Star an article in the inbox — the star beside Discard, or S — and it waits here for a
          closer look, whatever you decide about it there.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {message ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>
      ) : null}

      <ul className="space-y-3">
        {articles.map((a) => {
          const state = a.item_state ?? a.triage;
          const badge = state ? STATE[state] : undefined;
          const waiting = a.item_id !== null && a.item_state === "held";
          const enough = a.chars >= ENOUGH_TO_READ;
          const refuse = "There is no article behind this yet — paste it in from the inbox first";
          return (
            <li key={a.id} className="flex gap-4 rounded-xl border border-[var(--color-rule)] bg-white p-4">
              {a.image ? <Picture src={a.image} /> : null}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h3 className="font-serif text-lg font-semibold leading-snug" dir={dirOf(a.title)}>
                    <Link href={`/sources/${a.id}`} className="transition hover:text-[var(--color-accent)]">
                      {a.title}
                    </Link>
                  </h3>
                  {badge ? (
                    <span className={`rounded-full px-2 py-0.5 text-[11px] ${badge.tone}`}>{badge.label}</span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                  {[a.outlet, a.author, a.published_at ? formatDateTime(a.published_at) : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>

                {a.lede ? (
                  <p dir={dirOf(a.lede)} className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">
                    {a.lede}
                  </p>
                ) : null}

                <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-[var(--color-muted)]">
                  <span>{a.words.toLocaleString()} words</span>
                  <span title={formatDateTime(a.starred_at)}>starred {relativeDate(a.starred_at)}</span>

                  <span className="ms-auto flex flex-wrap items-center gap-2.5">
                    <Link
                      href={`/sources/${a.id}`}
                      className="inline-flex items-center rounded-full bg-[var(--color-accent)] px-3 py-1 font-medium text-white"
                    >
                      Read
                    </Link>
                    {a.url ? (
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 transition hover:text-[var(--color-accent)]"
                      >
                        <IconExternal size={13} /> Original
                      </a>
                    ) : null}
                    {waiting ? (
                      <>
                        <button
                          type="button"
                          disabled={busy || !enough}
                          onClick={() => void run("/api/inbox", { action: "keep", itemIds: [a.item_id] })}
                          title={enough ? "Read it into the pedia, and into the brief" : refuse}
                          className="inline-flex items-center gap-1 transition hover:text-[var(--color-accent)] disabled:opacity-30"
                        >
                          <IconCheck /> Keep
                        </button>
                        <button
                          type="button"
                          disabled={busy || !enough}
                          onClick={() => void run("/api/inbox", { action: "file", itemIds: [a.item_id] })}
                          title={enough ? "Read it into the library, but keep it out of the brief" : refuse}
                          className="inline-flex items-center gap-1 transition hover:text-[var(--color-accent)] disabled:opacity-30"
                        >
                          <IconShelf /> File
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run("/api/starred", { sourceId: a.id, starred: false })}
                      title="Take it off this list; nothing else about it changes"
                      className="inline-flex items-center gap-1 text-amber-600 transition hover:text-amber-800 disabled:opacity-30"
                    >
                      <IconStar size={14} fill="currentColor" /> Unstar
                    </button>
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The article's picture, gone without a trace when it will not load. */
function Picture({ src }: { src: string }) {
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
      className="hidden h-24 w-36 shrink-0 self-start rounded-md object-cover ring-1 ring-black/10 sm:block"
    />
  );
}
