import { db, tx } from "./db";
import { getConfig } from "./config";
import { createRun, enqueue } from "./queue";
import { appendReadingTail, queueUnreadInto } from "./reading";
import { writeChunks } from "./pipeline/ocr";
import { parseText } from "./ingest/text";
import { clean } from "./ingest/clean";
import { ftsMatch, likePattern, queryWords } from "./fts";

/**
 * The inbox: what a feed pulled in, waiting for you to say whether it matters.
 *
 * The old shape was that a feed found an article and the extractor read it,
 * immediately, all of it. That is right for a library you assembled book by
 * book and wrong for a beat. A wire feed carries the whole day, most of it is
 * somebody else's story, and reading it to discover that costs the most
 * expensive stage in the application — around 88% of all tokens — on material
 * you would have thrown away in two seconds by the headline.
 *
 * So the poll now stops one step earlier. Fetching the page and chunking it
 * are free and are still done, because a headline alone is not enough to judge
 * by and the first paragraph usually is. Everything after that waits here.
 *
 * Keeping an item is what starts the reading pipeline for it, and it is also
 * what puts it in the week: `decided_at` is the clock the weekly brief runs
 * on, not `seen_at`. An article you kept on Monday from a feed that published
 * it on Sunday is Monday's work, which is how you will remember it.
 */

export interface HeldItem {
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
  /** The opening of the article itself, which is what you actually judge by. */
  lede: string | null;
  chunks: number;
  /** Characters of article behind it. Below ENOUGH_TO_READ it cannot be kept. */
  chars: number;
  story_id: number | null;
  story_title: string | null;
  /** Other accounts of the same story already in the library. */
  story_accounts: number;
  /** A picture: the feed's, or failing that the page's own. An address, not a file. */
  image: string | null;
  /** The fetcher's note on the source — says when only the feed's summary could be read. */
  source_note: string | null;
  /** When the browser extension last sent its text. What you pushed heads the inbox. */
  clipped_at: string | null;
  /** 1 when the article is starred for a closer look (lib/starred.ts), else 0. */
  starred: number;
  /** The subject bundle the grouping pass put it in, if any. See lib/inbox-bundles.ts. */
  bundle_id: number | null;
  bundle_label: string | null;
  /** breaking | high | medium | evergreen, or null until the sorting pass rates it. See lib/importance.ts. */
  importance: string | null;
}

const HELD_COLUMNS = `
  i.id, i.feed_id, i.title, i.summary, i.url, i.published_at, i.seen_at,
  i.source_id, i.note, i.clipped_at, i.importance,
  f.title AS feed_title, f.outlet, f.reliability,
  (SELECT c.text FROM chunks c WHERE c.source_id = i.source_id ORDER BY c.seq LIMIT 1) AS lede,
  (SELECT COUNT(*) FROM chunks c WHERE c.source_id = i.source_id) AS chunks,
  (SELECT COALESCE(SUM(LENGTH(c.text)), 0) FROM chunks c WHERE c.source_id = i.source_id) AS chars,
  ss.story_id AS story_id,
  st.title AS story_title,
  (SELECT COUNT(*) FROM story_sources s2 WHERE s2.story_id = ss.story_id) AS story_accounts,
  COALESCE(i.image_url, json_extract(s.meta_json, '$.image')) AS image,
  s.note AS source_note,
  (s.starred_at IS NOT NULL) AS starred,
  bi.bundle_id AS bundle_id,
  b.label AS bundle_label`;

const HELD_JOINS = `
  FROM feed_items i
  JOIN feeds f ON f.id = i.feed_id
  LEFT JOIN sources s ON s.id = i.source_id
  LEFT JOIN story_sources ss ON ss.source_id = i.source_id
  LEFT JOIN stories st ON st.id = ss.story_id
  LEFT JOIN inbox_bundle_items bi ON bi.item_id = i.id
  LEFT JOIN inbox_bundles b ON b.id = bi.bundle_id`;

/** A search typed into the inbox, made safe for the full-text index. See lib/fts.ts. */
export const inboxMatch = ftsMatch;

/**
 * Everything waiting on you: what you sent from the browser first, most
 * recent clip first, then newest.
 *
 * With a query, only what matches it. Every word must be in what the row
 * shows — the headline, the summary, the outlet — or the article's own text
 * must hold all of them; the text is searched through the full-text index,
 * so an article whose headline says nothing about Alberta is still found by
 * the word Alberta in its fourth paragraph.
 */
export function listHeld(limit = 200, query?: string): HeldItem[] {
  const words = queryWords(query ?? "");
  const params: Record<string, string | number> = { limit };
  const run = (where: string, extra: Record<string, string> = {}) =>
    db()
      .prepare(
        `SELECT ${HELD_COLUMNS} ${HELD_JOINS}
          WHERE i.state = 'held' ${where}
          ORDER BY i.clipped_at IS NULL, i.clipped_at DESC, COALESCE(i.published_at, i.seen_at) DESC, i.id DESC
          LIMIT @limit`
      )
      .all({ ...params, ...extra }) as HeldItem[];

  let rows: HeldItem[];
  if (!words.length) {
    rows = run("");
  } else {
    // A typed % or _ is a character to find, not a wildcard.
    const shown = words
      .map((w, n) => {
        const p = `@w${n}`;
        params[`w${n}`] = likePattern(w);
        return `(i.title LIKE ${p} ESCAPE '\\' OR i.summary LIKE ${p} ESCAPE '\\'
                 OR f.title LIKE ${p} ESCAPE '\\' OR f.outlet LIKE ${p} ESCAPE '\\' OR s.outlet LIKE ${p} ESCAPE '\\')`;
      })
      .join(" AND ");
    const match = inboxMatch(words);
    const inText = `i.source_id IN (SELECT c.source_id FROM chunks c
                     WHERE c.id IN (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH @match))`;
    try {
      rows = match ? run(`AND ((${shown}) OR ${inText})`, { match }) : run(`AND (${shown})`);
    } catch {
      // Something the index still cannot parse: the headline match alone.
      rows = run(`AND (${shown})`);
    }
  }

  // The lede is for judging, not for reading — a paragraph is plenty and the
  // page is showing a hundred of them.
  return rows.map((r) => ({
    ...r,
    lede: r.lede ? r.lede.replace(/\s+/g, " ").trim().slice(0, 400) : null,
  }));
}

/**
 * Changes whenever the browser extension sends an article, and at no other time.
 *
 * The inbox asks for this every few seconds so a clip shows up without a
 * reload. Deliberately not the held count: that moves whenever a feed brings
 * something in, and a list that rearranges itself under you while you are
 * working through it is worse than one that waits.
 */
export function clipStamp(): string {
  const row = db()
    .prepare("SELECT COUNT(clipped_at) AS n, MAX(clipped_at) AS last FROM feed_items WHERE clipped_at IS NOT NULL")
    .get() as { n: number; last: string | null };
  return `${row.n}:${row.last ?? ""}`;
}

export interface HeldText {
  id: number;
  title: string;
  url: string | null;
  outlet: string | null;
  published_at: string | null;
  image: string | null;
  /** What the fetcher said about the source, e.g. that only the summary was read. */
  source_note: string | null;
  chars: number;
  words: number;
  /**
   * enough   — a real article is here; keeping it reads all of it.
   * summary  — the page would not open and only the feed's summary was kept.
   * thin     — something was read, but not enough to be an article.
   */
  verdict: "enough" | "summary" | "thin";
  passages: { seq: number; text: string }[];
}

/**
 * Everything that would be read if you kept this item, so you can see it
 * before deciding — and see whether it is the article or a paywall's stub.
 *
 * The verdict is the same rule keep() applies, spelled out: below
 * ENOUGH_TO_READ there is no article, and a source whose note says the page
 * would not open is the feed's summary however long it is.
 */
export function heldText(itemId: number): HeldText | null {
  const item = db()
    .prepare(
      `SELECT i.id, i.title, i.url, i.published_at, i.source_id, i.image_url,
              f.outlet, s.note AS source_note, s.meta_json
         FROM feed_items i
         JOIN feeds f ON f.id = i.feed_id
    LEFT JOIN sources s ON s.id = i.source_id
        WHERE i.id = ? AND i.state = 'held'`
    )
    .get(itemId) as
    | {
        id: number;
        title: string;
        url: string | null;
        published_at: string | null;
        source_id: number | null;
        image_url: string | null;
        outlet: string | null;
        source_note: string | null;
        meta_json: string | null;
      }
    | undefined;
  if (!item) return null;

  const passages = item.source_id
    ? (db()
        .prepare("SELECT seq, text FROM chunks WHERE source_id=? ORDER BY seq")
        .all(item.source_id) as { seq: number; text: string }[])
    : [];
  const chars = passages.reduce((n, p) => n + p.text.length, 0);
  const words = passages.reduce((n, p) => n + wordCount(p.text), 0);

  let image: string | null = item.image_url;
  if (!image && item.meta_json) {
    try {
      image = (JSON.parse(item.meta_json) as { image?: string }).image ?? null;
    } catch {
      image = null;
    }
  }

  const summaryOnly = /could not be read|summary the feed carried/i.test(item.source_note ?? "");
  const verdict = !enoughToRead(chars, words) ? "thin" : summaryOnly ? "summary" : "enough";

  return {
    id: item.id,
    title: item.title,
    url: item.url,
    outlet: item.outlet,
    published_at: item.published_at,
    image,
    source_note: item.source_note,
    chars,
    words,
    verdict,
    passages,
  };
}

export function heldCount(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM feed_items WHERE state='held'").get() as { n: number }).n;
}

/** What was decided in a window, for the week page and its counts. */
export function decidedBetween(from: Date, to: Date): { kept: number; filed: number; discarded: number } {
  const row = db()
    .prepare(
      `SELECT
         SUM(CASE WHEN state='kept'      THEN 1 ELSE 0 END) AS kept,
         SUM(CASE WHEN state='filed'     THEN 1 ELSE 0 END) AS filed,
         SUM(CASE WHEN state='discarded' THEN 1 ELSE 0 END) AS discarded
         FROM feed_items
        WHERE datetime(decided_at) >= datetime(?) AND datetime(decided_at) < datetime(?)`
      // Both sides through datetime(): decided_at is SQLite's own "YYYY-MM-DD
      // HH:MM:SS" and the bounds arrive as ISO with a T, and compared as text a
      // space sorts before a T — so anything decided on the window's first day
      // used to fall outside it.
    )
    .get(from.toISOString(), to.toISOString()) as { kept: number | null; filed: number | null; discarded: number | null };
  return { kept: row.kept ?? 0, filed: row.filed ?? 0, discarded: row.discarded ?? 0 };
}

/**
 * Says yes to an item, which is what queues the reading.
 *
 * Filing comes first for the same reason it does in ingest: one cheap call,
 * and the source is on the right shelf while it is being read. Extraction is
 * queued for every chunk the source has — a feed article is a handful, so
 * there is no read-along question to answer.
 */
/**
 * How much text an item must have before it can be kept.
 *
 * A paywalled article arrives as its headline and the feed's one-line summary
 * — measured on this library, the New York Times stubs run to about 230
 * characters and the Post's to 545, while the shortest real article is 1,300.
 * A thousand is the gap between them.
 *
 * The rule exists because keeping a stub is worse than not keeping it. It
 * makes a source with a citable title, a real outlet and a real date, whose
 * text is a sentence of marketing — and then an entry cites it, and the
 * citation opens on nothing. You have the subscriptions; paste the article in
 * and the same source becomes true.
 */
export const ENOUGH_TO_READ = 1_000;

/**
 * And a floor in words, because characters alone let a page's navigation
 * through: a broadcaster's menu, one link per line, ran to 1,400 characters
 * of "Skip to main content" and fifty-nine words. No article is that short.
 */
export const ENOUGH_WORDS = 120;

/** How much text this item actually has behind it. */
function textLength(sourceId: number | null): { chars: number; words: number } {
  if (sourceId === null) return { chars: 0, words: 0 };
  const rows = db().prepare("SELECT text FROM chunks WHERE source_id=?").all(sourceId) as { text: string }[];
  return {
    chars: rows.reduce((n, r) => n + r.text.length, 0),
    words: rows.reduce((n, r) => n + wordCount(r.text), 0),
  };
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Whether there is an article here, by both floors. */
export function enoughToRead(chars: number, words: number): boolean {
  return chars >= ENOUGH_TO_READ && words >= ENOUGH_WORDS;
}

export function keep(itemIds: number[]): {
  kept: number;
  runId: number | null;
  /** Refused for having nothing to read. Paste the article and keep it again. */
  refused: { id: number; title: string }[];
} {
  const r = admit(itemIds, "kept");
  return { kept: r.admitted, runId: r.runId, refused: r.refused };
}

/**
 * Says yes to an item for the library, and no for the brief.
 *
 * The same reading as keep — the article is read, its people and places get
 * entries, it is filed under its topics and grouped with its story — but the
 * source is marked `filed` rather than `kept`, and everything that builds the
 * brief (the day's and the week's material, the watching calendar, the
 * watchlist's recent counts) takes only `kept`. For the piece that belongs
 * in the pedia and not in the morning: a French election, a book review, a
 * beat you follow but do not present from.
 */
export function file(itemIds: number[]): {
  filed: number;
  runId: number | null;
  refused: { id: number; title: string }[];
} {
  const r = admit(itemIds, "filed");
  return { filed: r.admitted, runId: r.runId, refused: r.refused };
}

/** What keep and file share: everything but the word written on the source. */
function admit(
  itemIds: number[],
  verdict: "kept" | "filed"
): { admitted: number; runId: number | null; refused: { id: number; title: string }[] } {
  const all = pick(itemIds, "held");
  const refused = all
    .filter((i) => {
      const { chars, words } = textLength(i.source_id);
      return !enoughToRead(chars, words);
    })
    .map((i) => ({ id: i.id, title: i.title }));
  const items = all.filter((i) => !refused.some((r) => r.id === i.id));
  if (!items.length) return { admitted: 0, runId: null, refused };

  return tx(() => {
    let read: number | null = null;
    const runId = createRun({
      kind: "ingest",
      label:
        items.length === 1
          ? items[0].title
          : `Reading ${items.length} articles you ${verdict === "kept" ? "kept" : "filed"}`,
      budgetCap: getConfig().defaultBudget,
    });

    for (const item of items) {
      db()
        .prepare("UPDATE feed_items SET state=?, decided_at=datetime('now'), note=NULL WHERE id=?")
        .run(verdict, item.id);
      if (item.source_id === null) continue;

      // kept_at is set either way: it is the date the source entered the
      // library, which is what the shelf orders by. The brief reads the word.
      db()
        .prepare("UPDATE sources SET triage=?, kept_at=datetime('now') WHERE id=?")
        .run(verdict, item.source_id);

      const tagged = (
        db().prepare("SELECT tagged_at FROM sources WHERE id=?").get(item.source_id) as
          | { tagged_at: string | null }
          | undefined
      )?.tagged_at;
      const hasTags = (
        db().prepare("SELECT COUNT(*) AS n FROM source_tags WHERE source_id=?").get(item.source_id) as {
          n: number;
        }
      ).n;
      if (!tagged && !hasTags) {
        enqueue(runId, [{ kind: "tag" as const, payload: { sourceId: item.source_id } }]);
      }

      if (queueUnreadInto(runId, item.source_id) > 0) read = item.source_id;
    }

    // One tail for the lot. Resolution compares every new entity against every
    // known one, so running it per article would do the same work ten times
    // over and produce ten chances to merge the same pair.
    if (read !== null) appendReadingTail(runId, read);

    return { admitted: items.length, runId, refused };
  });
}

/**
 * Replaces a held article's text with what you pasted.
 *
 * The reason this exists is the paywall. You have subscriptions — the Post,
 * the Times — and Corpus does not: the fetcher gets a metered-content page or
 * a consent wall, and what lands in the inbox is a headline and the feed's own
 * summary. Reading that is a citation to a summary, which is the one thing
 * this application is built not to do.
 *
 * So: open it in your browser, where you are signed in, copy the article, and
 * paste it here before you keep it. The source keeps its address, its outlet
 * and its publication date — everything that makes the citation true — and
 * gains the text that was always meant to be behind them. Only a held item can
 * be pasted into; once it has been read, replacing the text underneath its
 * evidence would leave every quote pointing at a passage that no longer says
 * what it said.
 */
export function pasteText(itemId: number, text: string): { chunks: number; words: number } {
  const item = db()
    .prepare("SELECT id, source_id, title FROM feed_items WHERE id=? AND state='held'")
    .get(itemId) as { id: number; source_id: number | null; title: string } | undefined;
  if (!item) throw new Error("That item is not waiting in the inbox.");
  if (item.source_id === null) throw new Error("That item has nothing to paste into.");

  const body = text.trim();
  if (body.length < ENOUGH_TO_READ) {
    throw new Error(
      `That is ${body.length} characters; an article is at least ${ENOUGH_TO_READ}. Paste the whole piece.`
    );
  }

  const pieces = clean(parseText(body)).pieces;
  if (!pieces.length) throw new Error("Nothing readable in what was pasted.");

  return tx(() => {
    // The old chunks go entirely. A held source has no evidence hanging off
    // them yet, which is exactly why this is only offered before you keep it.
    db().prepare("DELETE FROM chunks WHERE source_id=?").run(item.source_id);
    const ids = writeChunks(item.source_id!, pieces);
    db()
      .prepare(
        `UPDATE sources SET status='chunked', read_mode='eager',
                note='The article text was pasted in by hand.' WHERE id=?`
      )
      .run(item.source_id);
    db()
      .prepare("UPDATE feed_items SET note='Full text pasted in.' WHERE id=?")
      .run(item.id);
    return { chunks: ids.length, words: body.split(/\s+/).length };
  });
}

/**
 * Says no.
 *
 * Everything stays on disk — the source row, and the text with it. The row is
 * what keeps the address recognisable, so the same story arriving from a
 * second feed is not offered to you twice; the text is what makes the decision
 * reversible, since undoing a discard whose article had been thrown away would
 * put back a headline with nothing behind it. An article is a few kilobytes,
 * and nothing about a discarded one is ever sent to a model.
 */
export function discard(itemIds: number[], reason?: string): { discarded: number } {
  const items = pick(itemIds, "held");
  if (!items.length) return { discarded: 0 };

  return tx(() => {
    for (const item of items) {
      db()
        .prepare("UPDATE feed_items SET state='discarded', decided_at=datetime('now'), note=? WHERE id=?")
        .run(reason?.trim() || null, item.id);
      if (item.source_id === null) continue;
      db()
        .prepare("UPDATE sources SET triage='discarded', kept_at=NULL, status='new' WHERE id=?")
        .run(item.source_id);
    }
    return { discarded: items.length };
  });
}

/**
 * Puts a discard back, for the one you clicked too fast.
 *
 * Only a discard. By the time an article has been kept it has been read, its
 * entities have been resolved against everything else in the library, and
 * pulling one back out of that is a different operation from changing your
 * mind — deleting the source is what does it, and it says what it will take.
 */
export function undo(itemIds: number[]): { restored: number; fetching: number; runId: number | null } {
  const items = pick(itemIds, "discarded");
  if (!items.length) return { restored: 0, fetching: 0, runId: null };

  return tx(() => {
    // An item the curator set aside was never fetched, so putting it back
    // means fetching it now — and telling the curator it was wrong. The veto
    // is what stops the pattern firing again; see lib/curator.ts.
    const toFetch: number[] = [];
    for (const item of items) {
      if (item.curated_at !== null) {
        db().prepare("UPDATE feed_items SET vetoed_at=datetime('now') WHERE id=?").run(item.id);
      }
      if (item.source_id === null && item.url) {
        db()
          .prepare("UPDATE feed_items SET state='queued', queued_at=datetime('now'), decided_at=NULL, note=NULL WHERE id=?")
          .run(item.id);
        toFetch.push(item.id);
        continue;
      }
      db()
        .prepare("UPDATE feed_items SET state='held', decided_at=NULL, note=NULL WHERE id=?")
        .run(item.id);
      if (item.source_id !== null) {
        db().prepare("UPDATE sources SET triage='held' WHERE id=?").run(item.source_id);
      }
    }

    let runId: number | null = null;
    if (toFetch.length) {
      runId = createRun({
        kind: "poll",
        label: toFetch.length === 1 ? "Fetching an article you put back" : `Fetching ${toFetch.length} articles you put back`,
      });
      enqueue(runId, toFetch.map((itemId) => ({ kind: "fetch_item" as const, payload: { itemId } })));
    }
    return { restored: items.length, fetching: toFetch.length, runId };
  });
}

interface PickedItem {
  id: number;
  title: string;
  source_id: number | null;
  url: string | null;
  curated_at: string | null;
}

/** The rows named that really are in the state the caller thinks they are. */
function pick(itemIds: number[], state: string): PickedItem[] {
  const ids = [...new Set(itemIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return [];
  return db()
    .prepare(
      `SELECT id, title, source_id, url, curated_at FROM feed_items
        WHERE state = ? AND id IN (${ids.map(() => "?").join(",")})`
    )
    .all(state, ...ids) as PickedItem[];
}
