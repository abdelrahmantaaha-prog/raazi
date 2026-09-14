import { db, tx } from "./db";
import { alreadyHave } from "./feeds";
import { applyMeta, rememberImage } from "./ingest";
import { canonicalUrl, outletFromUrl, toPublishedAt } from "./ingest/meta";
import { parseText } from "./ingest/text";
import { clean } from "./ingest/clean";
import { writeChunks } from "./pipeline/ocr";
import { fileSource } from "./stories";
import { enoughToRead, wordCount } from "./triage";
import { addNote, citationForSource, getDraft, notesFor } from "./drafts";
import { locateQuote } from "./pipeline/extract";

/**
 * An article sent straight from the browser.
 *
 * The feeds fetch a page as a stranger and get what a stranger gets: for a
 * subscription outlet, a headline and a sentence. The browser extension
 * reads the page as you — signed in, paywall open — and sends the article
 * itself, so the item lands in the inbox already whole. Same inbox, same
 * decision, same pipeline after it; the only difference is where the text
 * came from, and the item says so.
 *
 * Clips hang off one standing feed row, "Clipped from the browser", which is
 * disabled so the poller never asks it for anything. That keeps every clip an
 * ordinary feed item: it groups into stories, it counts in the week, it can
 * be discarded and undone, and the address is remembered so the same story
 * arriving from a real feed is recognised as already here.
 */

export const CLIP_FEED_URL = "corpus://clips";

export interface Clip {
  url: string;
  title: string;
  text: string;
  author?: string | null;
  publishedAt?: string | null;
  outlet?: string | null;
  image?: string | null;
  lang?: string | null;
}

export interface ClipResult {
  itemId: number;
  sourceId: number;
  words: number;
  chunks: number;
  /** True when the address was already waiting and its text was replaced. */
  replaced: boolean;
}

export class AlreadyReadError extends Error {
  constructor(public readonly sourceId: number) {
    super("That article is already in the library and has been read.");
    this.name = "AlreadyReadError";
  }
}

/** The one feed every clip belongs to, created on first use. */
export function clipFeedId(): number {
  const row = db().prepare("SELECT id FROM feeds WHERE url=?").get(CLIP_FEED_URL) as { id: number } | undefined;
  if (row) return row.id;
  return Number(
    db()
      .prepare(
        `INSERT INTO feeds (url, title, outlet, kind, enabled, interval_minutes, daily_cap, since, last_status)
         VALUES (?, 'Clipped from the browser', NULL, 'clip', 0, 525600, 100000, NULL, 'Filled by the browser extension; never polled.')`
      )
      .run(CLIP_FEED_URL).lastInsertRowid
  );
}

const MIN_TEXT = 200;

export function clipArticle(clip: Clip): ClipResult {
  const url = clip.url?.trim() ?? "";
  if (!/^https?:\/\//i.test(url)) throw new Error("A clip needs the page's address.");
  const title = (clip.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || url;
  const text = (clip.text ?? "").trim();
  if (text.length < MIN_TEXT) {
    throw new Error(`Only ${text.length} characters came through; select the article and try again.`);
  }

  const pieces = clean(parseText(text)).pieces;
  if (!pieces.length) throw new Error("Nothing readable in what was sent.");
  const canonical = canonicalUrl(url);
  const words = text.split(/\s+/).length;
  const publishedAt = toPublishedAt(clip.publishedAt) ?? undefined;
  const outlet = clip.outlet?.trim() || outletFromUrl(url) || undefined;
  const summary = pieces[0]?.text.replace(/\s+/g, " ").trim().slice(0, 300) || null;

  return tx(() => {
    const feedId = clipFeedId();
    const seen = alreadyHave(canonical, url);

    // The same address, already waiting: the clip is the full text the feed
    // could not get, so it replaces what is there — exactly what pasting does.
    if (seen.sourceId) {
      const source = db()
        .prepare("SELECT id, triage FROM sources WHERE id=?")
        .get(seen.sourceId) as { id: number; triage: string | null } | undefined;
      if (source && source.triage !== "held" && source.triage !== "discarded") {
        throw new AlreadyReadError(source.id);
      }
      if (source) {
        db().prepare("DELETE FROM chunks WHERE source_id=?").run(source.id);
        const ids = writeChunks(source.id, pieces);
        db()
          .prepare(
            `UPDATE sources SET status='chunked', triage='held', kept_at=NULL, read_mode='eager',
                    note='The article text was clipped from the browser, signed in.' WHERE id=?`
          )
          .run(source.id);
        applyMeta(source.id, { title, author: clip.author ?? undefined, outlet, publishedAt, lang: clip.lang ?? undefined });
        if (clip.image) rememberImage(source.id, clip.image);

        let item = db()
          .prepare("SELECT id FROM feed_items WHERE source_id=? ORDER BY id DESC LIMIT 1")
          .get(source.id) as { id: number } | undefined;
        if (item) {
          db()
            .prepare(
              `UPDATE feed_items SET state='held', decided_at=NULL, note='Full text clipped from the browser.',
                      clipped_at=strftime('%Y-%m-%d %H:%M:%f', 'now'),
                      image_url=COALESCE(image_url, ?) WHERE id=?`
            )
            .run(clip.image ?? null, item.id);
        } else {
          item = { id: insertItem(feedId, url, canonical, title, summary, publishedAt, source.id, clip.image) };
        }
        return { itemId: item.id, sourceId: source.id, words, chunks: ids.length, replaced: true };
      }
    }

    const sourceId = Number(
      db()
        .prepare(
          `INSERT INTO sources (title, kind, url, canonical_url, status, triage, read_mode, note)
           VALUES (?, 'url', ?, ?, 'chunked', 'held', 'eager', 'Clipped from the browser, signed in.')`
        )
        .run(title, url, canonical).lastInsertRowid
    );
    applyMeta(sourceId, { author: clip.author ?? undefined, outlet, publishedAt, lang: clip.lang ?? undefined });
    if (clip.image) rememberImage(sourceId, clip.image);
    const ids = writeChunks(sourceId, pieces);

    // An item the log already knows under this address — recorded by a feed
    // as a duplicate, or as something that failed to fetch — is taken over
    // rather than doubled.
    const known = seen.itemId
      ? (db().prepare("SELECT id FROM feed_items WHERE id=?").get(seen.itemId) as { id: number } | undefined)
      : undefined;
    let itemId: number;
    if (known) {
      db()
        .prepare(
          `UPDATE feed_items SET state='held', decided_at=NULL, source_id=?, title=?, summary=COALESCE(summary, ?),
                  note='Full text clipped from the browser.', image_url=COALESCE(image_url, ?),
                  clipped_at=strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id=?`
        )
        .run(sourceId, title, summary, clip.image ?? null, known.id);
      itemId = known.id;
    } else {
      itemId = insertItem(feedId, url, canonical, title, summary, publishedAt, sourceId, clip.image);
    }

    // Grouped with the accounts already running, like anything a feed brings.
    fileSource(sourceId);

    return { itemId, sourceId, words, chunks: ids.length, replaced: false };
  });
}

function insertItem(
  feedId: number,
  url: string,
  canonical: string | null,
  title: string,
  summary: string | null,
  publishedAt: string | undefined,
  sourceId: number,
  image: string | null | undefined
): number {
  return Number(
    db()
      .prepare(
        `INSERT INTO feed_items (feed_id, guid, url, canonical_url, title, summary, published_at, state, source_id, note, image_url, clipped_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?, 'Full text clipped from the browser.', ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))`
      )
      .run(feedId, canonical ?? url, url, canonical, title, summary, publishedAt ?? null, sourceId, image ?? null)
      .lastInsertRowid
  );
}

// ---------------------------------------------------------------------------
// Quotes gathered from the page, onto a draft.
// ---------------------------------------------------------------------------

/** A gathering that cannot happen, in words for the person reading the page. */
export class GatherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatherError";
  }
}

/** The source already made from an address, if one has been — for a second quote from a page already sent. */
export function sourceForUrl(url: string): number | null {
  if (!/^https?:\/\//i.test(url ?? "")) return null;
  return alreadyHave(canonicalUrl(url), url).sourceId ?? null;
}

/** The most quotes one gathering takes, and the longest quote. */
const MAX_QUOTES = 50;
const MAX_QUOTE_CHARS = 4000;

const sameWords = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Puts words marked on a page onto a draft's shelf, tied to the article.
 *
 * The extension sends the article and the quotes together, because they are
 * one thought — this sentence matters, and so does the piece it sits in. Each
 * quote is looked for in the article's own passages: found, it is stored as
 * the article has it (a selection carries the page's line breaks and odd
 * spacing; the passage does not) and linked to that passage, so its citation
 * names the place and the reader can open it there. Not found — typed, or
 * taken from a caption the reader left out — it is still kept, tied to the
 * source as a whole. The same words twice on one draft are kept once.
 */
export function gatherQuotes(
  draftId: number,
  sourceId: number,
  quotes: string[]
): { gathered: number; skipped: number; draftId: number; draftTitle: string } {
  const draft = getDraft(draftId);
  if (!draft) throw new GatherError("That draft is no longer here. Choose another in the extension.");

  const passages = db()
    .prepare("SELECT id, text FROM chunks WHERE source_id = ? ORDER BY seq")
    .all(sourceId) as { id: number; text: string }[];
  const onShelf = new Set(
    notesFor(draftId)
      .filter((n) => n.source_id === sourceId)
      .map((n) => sameWords(n.text))
  );

  let gathered = 0;
  let skipped = 0;
  for (const raw of quotes.map((q) => (q ?? "").trim()).filter(Boolean).slice(0, MAX_QUOTES)) {
    let text = raw.slice(0, MAX_QUOTE_CHARS);
    let chunkId: number | null = null;
    for (const p of passages) {
      const found = locateQuote(text, p.text);
      if (found) {
        text = found;
        chunkId = p.id;
        break;
      }
    }
    const key = sameWords(text);
    if (onShelf.has(key)) {
      skipped++;
      continue;
    }
    onShelf.add(key);
    addNote(draftId, {
      text,
      kind: "quote",
      citation: citationForSource(sourceId, chunkId),
      chunk_id: chunkId,
      source_id: sourceId,
    });
    gathered++;
  }
  return { gathered, skipped, draftId, draftTitle: draft.title };
}

/** Just enough for the extension to say whether the text it has is an article — the keep rule. */
export function clipVerdict(text: string): "enough" | "thin" {
  const t = text.trim();
  return enoughToRead(t.length, wordCount(t)) ? "enough" : "thin";
}
