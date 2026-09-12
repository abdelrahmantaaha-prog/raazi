import { db, tx } from "../db";
import { getConfig } from "../config";
import { createRun, enqueue, finishTask } from "../queue";
import { addUrl } from "../ingest";
import {
  dueFeeds,
  feedTags,
  fetchFeed,
  getFeed,
  ingestedToday,
  markPolled,
  recordItems,
} from "../feeds";
import { fileSource } from "../stories";
import { unwrapRedirect } from "../ingest/meta";
import type { Task } from "../types";

/**
 * Watching the feeds, as ordinary queue work.
 *
 * Nothing here calls a model. It is in the queue anyway because the queue is
 * what makes work survive a closed laptop: a poll that finds forty articles
 * becomes forty rows, each of which can fail, be retried, be paused when the
 * keys run out, and pick up three days later exactly where it stopped. A
 * `setInterval` would have none of that.
 *
 * Three kinds, in the order they run:
 *
 *   plan_polls  — which feeds are due. Free, and the only thing the idle loop
 *                 has to remember to call.
 *   poll        — fetch one feed, record what it carries, queue what is new.
 *   fetch_item  — turn one item into a source.
 *
 * What happens after fetch_item is what the `feedReview` setting decides. With
 * it on, which is the default for a beat, the article is fetched and chunked
 * and then waits in the inbox: nothing is filed, nothing is extracted, and no
 * token is spent until you say it is worth reading. With it off, the source
 * goes straight into the ordinary ingest pipeline as it always did.
 *
 * The daily cap is enforced at the moment of queueing rather than at ingest,
 * so a feed that republishes its archive costs one fetch and nothing else.
 */

/** How many items one poll may queue, however generous the cap. */
const PER_POLL_LIMIT = 25;

export async function handlePlanPolls(task: Task): Promise<void> {
  const free = { tokensIn: 0, tokensOut: 0 };
  const due = dueFeeds();

  if (due.length === 0) {
    finishTask(task.id, task.run_id, free, "done", "No feed is due yet.");
    return;
  }

  tx(() => {
    enqueue(
      task.run_id,
      due.map((f) => ({ kind: "poll" as const, payload: { feedId: f.id } }))
    );
    finishTask(
      task.id,
      task.run_id,
      free,
      "done",
      `${due.length} feed${due.length === 1 ? "" : "s"} due: ${due.map((f) => f.title).join(", ")}.`
    );
  });
}

export async function handlePoll(task: Task): Promise<void> {
  const { feedId } = JSON.parse(task.payload_json) as { feedId: number };
  const free = { tokensIn: 0, tokensOut: 0 };

  const feed = getFeed(feedId);
  if (!feed) {
    finishTask(task.id, task.run_id, free, "skipped", "That feed is gone.");
    return;
  }
  if (!feed.enabled) {
    finishTask(task.id, task.run_id, free, "skipped", "That feed is switched off.");
    return;
  }

  let result: Awaited<ReturnType<typeof fetchFeed>>;
  try {
    result = await fetchFeed(feed);
  } catch (err) {
    // A feed that is down is not a run that should stop. The failure is
    // recorded on the feed, where you can see it, and the poll is done.
    markPolled(feedId, `Failed: ${(err as Error).message}`.slice(0, 200));
    finishTask(task.id, task.run_id, free, "done", `${feed.title}: ${(err as Error).message}`);
    return;
  }

  if (result.status === 304 || !result.parsed) {
    markPolled(feedId, "No change", result.etag, result.lastModified);
    finishTask(task.id, task.run_id, free, "done", `${feed.title}: nothing new.`);
    return;
  }

  const fresh = recordItems(feedId, result.parsed.items, feed.since);
  const room = Math.max(0, feed.daily_cap - ingestedToday(feedId));
  const take = fresh.slice(0, Math.min(room, PER_POLL_LIMIT));
  const held = fresh.length - take.length;

  tx(() => {
    if (take.length) {
      db()
        .prepare(`UPDATE feed_items SET state='queued' WHERE id IN (${take.map(() => "?").join(",")})`)
        .run(...take);
      enqueue(
        task.run_id,
        take.map((itemId) => ({ kind: "fetch_item" as const, payload: { itemId } }))
      );
    }
    if (held > 0) {
      const heldIds = fresh.slice(take.length);
      db()
        .prepare(
          `UPDATE feed_items SET note='Held back: this feed has had its fill for today.'
            WHERE id IN (${heldIds.map(() => "?").join(",")})`
        )
        .run(...heldIds);
    }
    markPolled(feedId, `${result.parsed!.items.length} item(s) offered`, result.etag, result.lastModified);
    finishTask(
      task.id,
      task.run_id,
      free,
      "done",
      take.length === 0
        ? `${feed.title}: nothing new to read${held ? `; ${held} held back by the daily cap` : ""}.`
        : `${feed.title}: reading ${take.length} new item${take.length === 1 ? "" : "s"}${held ? `, ${held} held back` : ""}.`
    );
  });
}

export async function handleFetchItem(task: Task): Promise<void> {
  const { itemId } = JSON.parse(task.payload_json) as { itemId: number };
  const free = { tokensIn: 0, tokensOut: 0 };

  const item = db()
    .prepare(
      `SELECT i.*, f.outlet AS feed_outlet, f.title AS feed_title, f.id AS feed_id
         FROM feed_items i JOIN feeds f ON f.id = i.feed_id
        WHERE i.id = ?`
    )
    .get(itemId) as
    | {
        id: number;
        feed_id: number;
        url: string | null;
        canonical_url: string | null;
        title: string;
        summary: string | null;
        published_at: string | null;
        state: string;
        feed_outlet: string | null;
        feed_title: string;
      }
    | undefined;

  if (!item) {
    finishTask(task.id, task.run_id, free, "skipped", "That item is gone.");
    return;
  }
  if (item.state === "ready") {
    finishTask(task.id, task.run_id, free, "skipped", "Already read.");
    return;
  }
  if (!item.url) {
    db().prepare("UPDATE feed_items SET state='skipped', note='No address to fetch.' WHERE id=?").run(itemId);
    finishTask(task.id, task.run_id, free, "skipped", "The item carried no address.");
    return;
  }

  try {
    // A search feed links to itself and carries the destination in a query
    // parameter; the canonical address everything is deduplicated on has to be
    // the article's, not the redirector's.
    const target = unwrapRedirect(item.url);
    const review = getConfig().feedReview;

    const added = await addUrl({
      url: target,
      title: item.title,
      publishedAt: item.published_at ?? undefined,
      outlet: item.feed_outlet ?? undefined,
      tags: feedTags(item.feed_id),
      // The whole poll shares one run, so pausing "this morning's feeds" is
      // one action and the Activity list stays readable.
      runId: task.run_id,
      // What to keep if the page will not open. A search feed's items point at
      // aggregators that render in the browser, and this is the difference
      // between a phrase watch that reports something and one that reports
      // only failures.
      fallbackText: [item.title, item.summary].filter(Boolean).join("\n\n"),
      // Fetched and chunked, then left alone until you decide. See lib/triage.ts.
      hold: review,
    });

    // Which running story this account belongs to. Grouping needs the source
    // to exist and is cheap; entity overlap improves once it is extracted, so
    // the ingest tail files it again when the passages are in. It happens
    // before the decision deliberately: "the fourth account of a story you
    // already have" is exactly what makes an item easy to judge in the inbox.
    const story = fileSource(added.sourceId);
    const running = story?.created === false;

    db()
      .prepare("UPDATE feed_items SET state=?, source_id=?, note=? WHERE id=?")
      .run(
        review ? "held" : "ready",
        added.sourceId,
        running ? "Another account of a story already running." : null,
        itemId
      );

    finishTask(
      task.id,
      task.run_id,
      free,
      "done",
      review
        ? `Pulled "${item.title}" — waiting for you in the inbox${running ? " (a story already running)" : ""}.`
        : `Read "${item.title}"${running ? " (an account of a story already running)" : ""}.`
    );
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    db().prepare("UPDATE feed_items SET state='failed', note=? WHERE id=?").run(message, itemId);
    // One article that will not parse is not a reason to stop the morning.
    finishTask(task.id, task.run_id, free, "done", `Could not read "${item.title}": ${message}`);
  }
}

/**
 * Queues a poll of everything due, as its own run.
 *
 * Called by the worker's idle loop and by the morning routine; also what the
 * "Check feeds now" button uses. Returns null when nothing is due, so a caller
 * can stay quiet.
 */
export function queuePolls(label = "Checking feeds"): { runId: number; feeds: number } | null {
  const due = dueFeeds();
  if (due.length === 0) return null;

  return tx(() => {
    const runId = createRun({
      kind: "poll",
      label: `${label} (${due.length})`,
      budgetCap: getConfig().defaultBudget,
    });
    enqueue(
      runId,
      due.map((f) => ({ kind: "poll" as const, payload: { feedId: f.id } }))
    );
    return { runId, feeds: due.length };
  });
}

/**
 * True when a poll itself is queued or running — the check of the feeds,
 * not the article fetches it left behind.
 *
 * This is the guard for queueing the next check. The fetches are the
 * chunking and parsing the feeds are meant to run ahead of, and a feed that
 * has fallen due is due whether or not the last poll's articles have been
 * read: gating on them meant an hourly feed was checked once per batch of
 * articles rather than once an hour.
 */
export function pollPending(): boolean {
  return (
    (
      db()
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks
            WHERE kind IN ('poll', 'plan_polls') AND state IN ('pending', 'running')`
        )
        .get() as { n: number }
    ).n > 0
  );
}

/** True when a poll or anything it queued is still in flight — the brief
 *  waits on this, since "after the articles are in" is what it means. */
export function pollInFlight(): boolean {
  return (
    (
      db()
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks
            WHERE kind IN ('poll', 'plan_polls', 'fetch_item') AND state IN ('pending', 'running')`
        )
        .get() as { n: number }
    ).n > 0
  );
}
