"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { EntityRow } from "@/lib/queries";
import type { Tag } from "@/lib/tags";
import { ENTITY_LABEL } from "@/lib/types";
import { Badge, Button, Card } from "../../components/ui";
import { TagChip } from "../../components/TagFilter";
import { Reader, type Mark, type Passage } from "./Reader";
import { Player } from "./Player";
import { videoId } from "@/lib/video";
import { SourceCover } from "../../components/SourceCover";
import { RunChip } from "../../components/RunChip";
import { MatchCover } from "./MatchCover";
import { guessShelf } from "@/lib/shelves";
import type { ReadMode } from "@/lib/reading";
import { formatDate, formatDateTime, relativeDate } from "@/lib/dates";
import { ArticleLink } from "../../components/ArticleLink";
import { Translations } from "./Translations";
import { Shipping, type ShippingView } from "./Shipping";
import { TextWebCheck } from "../../components/TextWebCheck";
import type { WebReport } from "@/lib/web-checks";
import type { TranslationSummary } from "@/lib/translations";

interface SourceMeta {
  id: number;
  title: string;
  author: string | null;
  kind: string;
  year: string | null;
  publisher: string | null;
  url: string | null;
  status: string;
  note: string | null;
  added_at: string;
  words: number;
  bookmark_chunk: number | null;
  read_at: string | null;
  shelf: string | null;
  mode: ReadMode;
}

export function SourceView({
  source,
  passages,
  entities,
  tags,
  unread,
  position,
  marks,
  initialChunk = null,
  translations,
  original,
  shipping = null,
  webCheck = null,
}: {
  source: SourceMeta;
  passages: Passage[];
  entities: EntityRow[];
  tags: Tag[];
  unread: number;
  position: {
    chunkId: number | null;
    offset: number;
    progress: number;
    read: number[];
    /** Passages read only partway, and how far into each. */
    partly: Record<number, number>;
  };
  marks: Mark[];
  /** A passage the URL asked for: the reader opens straight away, at it. */
  initialChunk?: number | null;
  /** The translations paired with this book, when it is an original. */
  translations: TranslationSummary[];
  /** The book this one translates, when it is a translation. */
  original: { id: number; title: string } | null;
  /** The shipment this paper records, when it is a shipping paper. */
  shipping?: ShippingView | null;
  /** The last check of this source's claims on the web. */
  webCheck?: WebReport | null;
}) {
  const router = useRouter();
  const [reading, setReading] = useState(initialChunk !== null);
  /** The passage to open the reader at; cleared once used. */
  const [openAt, setOpenAt] = useState<number | null>(initialChunk);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** The run the last button started, so the page can say what became of it. */
  const [run, setRun] = useState<number | null>(null);

  /**
   * Quotes from this source that lean on something they do not name.
   *
   * Counted on demand rather than stored, because the answer changes every time
   * a passage is read or resolved, and a stale number beside a button that
   * spends tokens is worse than no number.
   *
   * Declared up here with the other hooks, above the `if (reading)` return
   * below, and that placement is load-bearing: React identifies hooks by call
   * order, so a hook after a conditional return is skipped on the renders that
   * take it. Put below, these two made the whole page go blank the moment the
   * reader opened — "rendered fewer hooks than expected", and an unmounted tree.
   */
  const [adrift, setAdrift] = useState<{ quotes: number; passages: number } | null>(null);
  useEffect(() => {
    void fetch(`/api/sources/${source.id}/context`)
      .then((r) => r.json())
      .then(setAdrift)
      .catch(() => setAdrift(null));
  }, [source.id]);

  if (reading) {
    return (
      <Reader
        passages={passages}
        pdf={source.kind === "pdf"}
        title={source.title}
        author={source.author}
        sourceId={source.id}
        position={position}
        marks={marks}
        readAlong={{ on: source.mode === "along", remaining: unread }}
        initialChunk={openAt}
        onClose={() => {
          setReading(false);
          setOpenAt(null);
          // The position and anything read-along queued while you were in there
          // are now stale on this page.
          router.refresh();
        }}
      />
    );
  }

  const reextract = async () => {
    // The scope the server will pick: the passages you have read, or the whole
    // source when the reading record is empty. Said here, before the click,
    // because "Read again" quietly meaning two different sizes of job is the
    // kind of surprise a confirm dialog exists to prevent.
    const readCount = position.read.length;
    const clean = confirm(
      readCount > 0
        ? `Re-read the ${readCount} passage${readCount === 1 ? "" : "s"} you've read of ` +
            `"${source.title}"?\n\n` +
            `Quotes, relations and dated events drawn from those passages are discarded and ` +
            `rebuilt; the rest of the book is untouched and unread parts are still read only ` +
            `as you reach them. Entities left with no evidence anywhere are removed; the rest ` +
            `are marked for rewriting.\n\nOther sources are untouched.`
        : `Read "${source.title}" again from scratch?\n\n` +
            `You haven't read any of it yet, so this re-reads the whole source. Everything ` +
            `currently drawn from it — ${entities.length}+ entities' quotes, its relations and ` +
            `its dated events — is discarded and rebuilt. Entities left with no evidence ` +
            `anywhere are removed; the rest keep their other sources and are marked for ` +
            `rewriting.\n\nOther sources are untouched.`
    );
    if (!clean) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/sources/${source.id}/reextract`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not queue it.");
      setMessage(data.note);
      setRun(data.runId ?? data.run?.id ?? null);
      router.refresh();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enhance = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/sources/${source.id}/enhance`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not queue it.");
      setMessage(data.note);
      setRun(data.runId ?? data.run?.id ?? null);
      router.refresh();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restoreContext = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/sources/${source.id}/context`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not queue it.");
      setMessage(
        data.passages === 0
          ? "Every passage from this source already stands on its own."
          : `Queued ${data.passages} passage(s) that need their bearings.`
      );
      setRun(data.runId ?? data.run?.id ?? null);
      setAdrift({ quotes: 0, passages: 0 });
      router.refresh();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const minutes = Math.max(1, Math.round(source.words / 230));
  const duration = readingTime(minutes);
  const read = passages.length - unread;
  const video = videoId(source.url);

  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm text-[var(--color-muted)] hover:text-[var(--color-accent)]">
        ← Library
      </Link>

      {video && (
        <Player videoId={video} title={source.title} />
      )}

      <div className="flex flex-wrap gap-6">
        {!video && (
          <div className="w-[128px] shrink-0">
            <SourceCover
              sourceId={source.id}
              title={source.title}
              author={source.author}
              kind={source.kind}
              className="w-[128px]"
            />
          </div>
        )}

        <div className="min-w-[18rem] flex-1 space-y-3">
          <div className="space-y-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-serif text-2xl font-semibold leading-tight">{source.title}</h1>
                {source.status !== "ready" && (
                  <Badge tone={source.status === "failed" ? "danger" : "running"}>
                    {source.status}
                  </Badge>
                )}
              </div>

              {/* The author gets a line of their own. Run together with the
                  publisher and the file type in one grey stream, the one thing
                  you actually look for was the hardest thing to find. */}
              {source.author && (
                <p className="mt-1 font-serif text-lg text-[var(--color-ink)]">{source.author}</p>
              )}

              <p className="mt-1 text-xs uppercase tracking-[0.1em] text-[var(--color-muted)]">
                {[source.publisher, source.year, source.kind].filter(Boolean).join(" · ")}
              </p>
              <p className="mt-1 text-xs text-[var(--color-muted)]" title={formatDateTime(source.added_at)}>
                Added {relativeDate(source.added_at)}
              </p>
            </div>

            <ReadingProgress
              progress={position.progress}
              indexed={passages.length ? read / passages.length : 0}
              mode={source.mode}
              lastOpened={source.read_at}
            />

            <Figures
              items={[
                { value: source.words.toLocaleString(), label: "words" },
                { value: duration.value, label: duration.label },
                { value: `${passages.length}`, label: passages.length === 1 ? "passage" : "passages" },
                ...(marks.length
                  ? [{ value: `${marks.length}`, label: marks.length === 1 ? "bookmark" : "bookmarks" }]
                  : []),
              ]}
            />

            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <Link key={t.id} href={`/pedia?tag=${t.id}`}>
                    <TagChip name={t.name} color={t.color} />
                  </Link>
                ))}
              </div>
            )}

            {original ? (
              <p className="text-sm text-[var(--color-muted)]">
                A translation of{" "}
                <Link href={`/sources/${original.id}`} className="text-[var(--color-ink)] hover:underline">
                  {original.title}
                </Link>{" "}
                ·{" "}
                <Link
                  href={`/sources/${original.id}/bilingual?with=${source.id}`}
                  className="font-medium text-[var(--color-accent)] hover:underline"
                >
                  Read them side by side
                </Link>
              </p>
            ) : (
              <Translations sourceId={source.id} initial={translations} />
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => setReading(true)} disabled={!passages.length}>
              {position.progress > 0.005 ? "Resume reading" : "Read"}
            </Button>
            {source.url && (
              <ArticleLink href={source.url}
                className="rounded border border-[var(--color-rule)] bg-white px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-accent-soft)]"
              >
                Open original
              </ArticleLink>
            )}
            <Button
              onClick={enhance}
              disabled={busy || read === 0}
              title="Look again at what has already been read, for anything the first pass missed. Nothing already extracted is lost."
            >
              {busy ? "Queueing…" : "Enhance"}
            </Button>
            {adrift !== null && adrift.quotes > 0 && (
              <Button
                onClick={restoreContext}
                disabled={busy}
                title="Some passages refer to things named earlier in the book. This reads the surrounding text and records what each one points at."
              >
                {busy ? "Queueing…" : `Restore context (${adrift.quotes})`}
              </Button>
            )}
            <Button onClick={reextract} disabled={busy || !passages.length}>
              {busy ? "Queueing…" : "Read again"}
            </Button>
          </div>
          <p className="text-xs text-[var(--color-muted)]">
            <span className="font-medium">Enhance</span> keeps everything and adds what was missed.{" "}
            <span className="font-medium">Read again</span> discards and rebuilds the extraction
            for the passages you&rsquo;ve read — or the whole source if you haven&rsquo;t read any
            of it yet.
            {adrift !== null && adrift.quotes > 0 && (
              <>
                {" "}
                <span className="font-medium">Restore context</span> resolves what{" "}
                {adrift.quotes} passage{adrift.quotes === 1 ? "" : "s"} refer back to, so they can be
                read on their own.
              </>
            )}
          </p>

          {message && (
            <p className="rounded border border-[var(--color-rule)] bg-white px-3 py-2 text-sm">
              {message}
            </p>
          )}
          {run && <RunChip runId={run} />}
          {source.note && source.status === "failed" && (
            <p className="text-sm text-red-700">{source.note}</p>
          )}
        </div>
      </div>

      <MatchCover
        sourceId={source.id}
        title={source.title}
        shelf={source.shelf}
        guessed={guessShelf({ kind: source.kind, words: source.words })}
      />

      <PediaSwitch sourceId={source.id} mode={source.mode} indexed={entities.length} />

      {shipping && <Shipping view={shipping} />}

      {passages.length > 0 && <TextWebCheck target="source" id={source.id} report={webCheck} />}

      {entities.length > 0 && (
        <Card>
          <h2 className="font-serif text-lg font-semibold">What this source contributes</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {entities.map((e) => (
              <Link
                key={e.id}
                href={`/pedia/${e.id}`}
                className="rounded-full border border-[var(--color-rule)] px-3 py-1 text-sm transition hover:bg-[var(--color-accent-soft)]"
                title={`${ENTITY_LABEL[e.type]} · ${e.mentions} passage(s)`}
              >
                {e.canonical_name}
                <span className="ml-1.5 text-xs text-[var(--color-muted)]">{e.mentions}</span>
              </Link>
            ))}
          </div>
        </Card>
      )}

      <details className="rounded-lg border border-[var(--color-rule)] bg-white">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          Inspect the passages Raazi works in ({passages.length})
        </summary>
        <div className="space-y-3 border-t border-[var(--color-rule)] p-4">
          <p className="text-sm text-[var(--color-muted)]">
            These are the windows the text was split into for reading — they overlap on purpose, so
            a sentence spanning a seam still makes sense to the model. Useful for checking a
            citation, not for reading.
          </p>
          {passages.map((p) => (
            <article key={p.id} id={`c${p.id}`} className="rounded border border-[var(--color-rule)] p-3">
              <div className="mb-2 flex items-center gap-2 text-xs text-[var(--color-muted)]">
                <span>{p.locator || "—"}</span>
                <button
                  type="button"
                  onClick={() => {
                    setOpenAt(p.id);
                    setReading(true);
                  }}
                  className="hover:text-[var(--color-accent)] hover:underline"
                  title="Open the reader at this passage"
                >
                  read here
                </button>
                {p.extracted ? <Badge tone="ok">read</Badge> : <Badge tone="quiet">not read</Badge>}
                {readBy(p) && <Badge>{readBy(p)}</Badge>}
                {p.mentions.length > 0 && <span>· {p.mentions.length} mentions</span>}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{p.text}</p>
            </article>
          ))}
        </div>
      </details>
    </div>
  );
}

/** Which model(s) read a passage, from the mentions it left; null when none said. */
function readBy(p: Passage): string | null {
  const names = [...new Set(p.mentions.map((m) => m.model).filter((m): m is string => Boolean(m)))];
  return names.length ? names.join(", ") : null;
}

/**
 * How far you have read, and how far Raazi has got.
 *
 * These are two different facts and the old layout ran them together as prose,
 * which made neither legible: "12% read" sat in one grey line and "41 still
 * ahead of Raazi" in another, with nothing to say they were two ends of the
 * same measurement. Drawn as one track with two fills, the relationship is the
 * point — you can see the index trailing behind your reading, catching up, or
 * (on a source read eagerly) already finished.
 */
function ReadingProgress({
  progress,
  indexed,
  mode,
  lastOpened,
}: {
  progress: number;
  indexed: number;
  mode: ReadMode;
  lastOpened: string | null;
}) {
  const you = Math.round(progress * 100);
  const corpus = Math.round(indexed * 100);
  if (you === 0 && corpus === 0) return null;

  return (
    <div className="rounded-lg border border-[var(--color-rule)] bg-white px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-serif text-xl font-semibold">
          {you}%
          <span className="ms-1.5 text-sm font-normal text-[var(--color-muted)]">read</span>
        </span>
        {lastOpened && (
          <span className="text-xs text-[var(--color-muted)]" title={formatDateTime(lastOpened)}>
            last opened {formatDate(lastOpened)}
          </span>
        )}
      </div>

      {/* One track, two fills. The index sits behind your reading, so where it
          has caught up the bar simply reads as solid. */}
      <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-accent-soft)]">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-accent)] opacity-25 transition-[width] duration-500"
          style={{ width: `${corpus}%` }}
          title={`Raazi has indexed ${corpus}% of this source`}
        />
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-accent)] transition-[width] duration-500"
          style={{ width: `${you}%` }}
          title={`You have read ${you}%`}
        />
      </div>

      <p className="mt-1.5 text-xs text-[var(--color-muted)]">
        {mode === "shelf"
          ? "Kept on the shelf: readable and searchable, never read into the pedia."
          : corpus >= 99
          ? "Raazi has read all of it."
          : mode === "along"
            ? `Raazi has indexed ${corpus}% — it reads each passage as you get to it.`
            : `Raazi has indexed ${corpus}%.`}
      </p>
    </div>
  );
}

/**
 * Whether this source feeds the pedia at all.
 *
 * Not everything worth keeping is research. A novel, an art book, a catalogue:
 * you want to read it here, search it, quote from it by hand — and you do not
 * want its characters and painters standing in the pedia beside the people you
 * cover, nor to pay the extraction stage to put them there. Shelving a source
 * stops that, and it is reversible: switching back reads it from the beginning.
 */
function PediaSwitch({
  sourceId,
  mode,
  indexed,
}: {
  sourceId: number;
  mode: ReadMode;
  indexed: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function set(next: ReadMode) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sources/${sourceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ readMode: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "That did not work.");
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-serif text-lg font-semibold">What this does to the pedia</h2>
          <p className="mt-1 max-w-[60ch] text-sm text-[var(--color-muted)]">
            {mode === "shelf"
              ? "On the shelf. You can read it, search it and quote from it, and nothing in it becomes evidence or an entry."
              : mode === "along"
                ? "Read along: each passage is indexed as you get to it, and what it finds joins the pedia."
                : "Indexed in full, and what it finds joins the pedia."}
            {mode === "shelf" && indexed > 0
              ? ` ${indexed} subject${indexed === 1 ? "" : "s"} it contributed before you shelved it are still there — delete the source to take those with it.`
              : ""}
          </p>
        </div>
        <select
          className="rounded border border-[var(--color-rule)] bg-white px-2 py-1.5 text-sm"
          value={mode}
          disabled={busy}
          onChange={(e) => void set(e.target.value as ReadMode)}
          aria-label="What this source does to the pedia"
        >
          <option value="eager">Read it into the pedia</option>
          <option value="along">Read it as I read it</option>
          <option value="shelf">Reading only — keep it out</option>
        </select>
      </div>
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
    </Card>
  );
}

/** A row of figures, each large enough to read at a glance. */
function Figures({ items }: { items: { value: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      {items.map((f) => (
        <div key={f.label}>
          <div className="font-serif text-lg font-semibold leading-none">{f.value}</div>
          <div className="mt-0.5 text-xs text-[var(--color-muted)]">{f.label}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * How long the thing takes to read, in a unit a person would use.
 *
 * "667 minutes" is arithmetically correct and tells you nothing — nobody plans
 * around six hundred minutes. Past an hour and a half it becomes hours, and
 * past a day of solid reading it says so, because at that point the honest
 * answer is "this is a long book" rather than a number.
 */
function readingTime(minutes: number): { value: string; label: string } {
  if (minutes < 90) return { value: `${minutes}`, label: minutes === 1 ? "minute" : "minutes" };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { value: `${hours}`, label: hours === 1 ? "hour" : "hours" };
  return { value: `${Math.round(hours / 24)}`, label: "days of reading" };
}
