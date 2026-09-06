import { db, tx } from "./db";
import { getConfig } from "./config";
import { createRun, enqueue } from "./queue";
import { appendReadingTail, queueUnreadInto } from "./reading";
import { writeChunks } from "./pipeline/ocr";
import { parseText } from "./ingest/text";
import { clean } from "./ingest/clean";

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
  story_id: number | null;
  story_title: string | null;
  /** Other accounts of the same story already in the library. */
  story_accounts: number;
}

const HELD_COLUMNS = `
  i.id, i.feed_id, i.title, i.summary, i.url, i.published_at, i.seen_at,
  i.source_id, i.note,
  f.title AS feed_title, f.outlet, f.reliability,
  (SELECT c.text FROM chunks c WHERE c.source_id = i.source_id ORDER BY c.seq LIMIT 1) AS lede,
  (SELECT COUNT(*) FROM chunks c WHERE c.source_id = i.source_id) AS chunks,
  ss.story_id AS story_id,
  st.title AS story_title,
  (SELECT COUNT(*) FROM story_sources s2 WHERE s2.story_id = ss.story_id) AS story_accounts`;

const HELD_JOINS = `
  FROM feed_items i
  JOIN feeds f ON f.id = i.feed_id
  LEFT JOIN story_sources ss ON ss.source_id = i.source_id
  LEFT JOIN stories st ON st.id = ss.story_id`;

/** Everything waiting on you, newest first. */
export function listHeld(limit = 200): HeldItem[] {
  const rows = db()
    .prepare(
      `SELECT ${HELD_COLUMNS} ${HELD_JOINS}
        WHERE i.state = 'held'
        ORDER BY COALESCE(i.published_at, i.seen_at) DESC, i.id DESC
        LIMIT ?`
    )
    .all(limit) as HeldItem[];

  // The lede is for judging, not for reading — a paragraph is plenty and the
  // page is showing a hundred of them.
  return rows.map((r) => ({
    ...r,
    lede: r.lede ? r.lede.replace(/\s+/g, " ").trim().slice(0, 400) : null,
  }));
}

export function heldCount(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM feed_items WHERE state='held'").get() as { n: number }).n;
}

/** What was decided in a window, for the week page and its counts. */
export function decidedBetween(from: Date, to: Date): { kept: number; discarded: number } {
  const row = db()
    .prepare(
      `SELECT
         SUM(CASE WHEN state='kept'      THEN 1 ELSE 0 END) AS kept,
         SUM(CASE WHEN state='discarded' THEN 1 ELSE 0 END) AS discarded
         FROM feed_items
        WHERE decided_at >= ? AND decided_at < ?`
    )
    .get(from.toISOString(), to.toISOString()) as { kept: number | null; discarded: number | null };
  return { kept: row.kept ?? 0, discarded: row.discarded ?? 0 };
}

/**
 * Says yes to an item, which is what queues the reading.
 *
 * Filing comes first for the same reason it does in ingest: one cheap call,
 * and the source is on the right shelf while it is being read. Extraction is
 * queued for every chunk the source has — a feed article is a handful, so
 * there is no read-along question to answer.
 */
export function keep(itemIds: number[]): { kept: number; runId: number | null } {
  const items = pick(itemIds, "held");
  if (!items.length) return { kept: 0, runId: null };

  return tx(() => {
    let read: number | null = null;
    const runId = createRun({
      kind: "ingest",
      label: items.length === 1 ? items[0].title : `Reading ${items.length} articles you kept`,
      budgetCap: getConfig().defaultBudget,
    });

    for (const item of items) {
      db()
        .prepare(
          "UPDATE feed_items SET state='kept', decided_at=datetime('now'), note=NULL WHERE id=?"
        )
        .run(item.id);
      if (item.source_id === null) continue;

      db()
        .prepare("UPDATE sources SET triage='kept', kept_at=datetime('now') WHERE id=?")
        .run(item.source_id);

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

    return { kept: items.length, runId };
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
  if (body.length < 200) throw new Error("That looks too short to be the article.");

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
export function undo(itemIds: number[]): { restored: number } {
  const items = pick(itemIds, "discarded");
  if (!items.length) return { restored: 0 };

  return tx(() => {
    for (const item of items) {
      db()
        .prepare("UPDATE feed_items SET state='held', decided_at=NULL, note=NULL WHERE id=?")
        .run(item.id);
      if (item.source_id !== null) {
        db().prepare("UPDATE sources SET triage='held' WHERE id=?").run(item.source_id);
      }
    }
    return { restored: items.length };
  });
}

interface PickedItem {
  id: number;
  title: string;
  source_id: number | null;
}

/** The rows named that really are in the state the caller thinks they are. */
function pick(itemIds: number[], state: string): PickedItem[] {
  const ids = [...new Set(itemIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return [];
  return db()
    .prepare(
      `SELECT id, title, source_id FROM feed_items
        WHERE state = ? AND id IN (${ids.map(() => "?").join(",")})`
    )
    .all(state, ...ids) as PickedItem[];
}
