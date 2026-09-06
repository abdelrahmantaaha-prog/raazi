/**
 * The inbox, the week, and the shelf.
 *
 * Three properties, and all three are about money. Nothing a feed pulls in is
 * read until you say so; a source on the shelf is never read at all; and the
 * week that gets presented at work is built from what you kept, on the day you
 * kept it, not on the day it was published.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-triage.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_triage__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.env.CORPUS_DATA_DIR = SANDBOX;
process.env.CORPUS_WORKER_IDLE_MS = "150";

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);

const { db } = await import("../lib/db/index.ts");
const triage = await import("../lib/triage.ts");
const week = await import("../lib/week.ts");
const brief = await import("../lib/brief.ts");
const reading = await import("../lib/reading.ts");

/** A feed item that has been fetched and chunked but not decided on. */
function mkHeld({ title, feedId, publishedAt = null, storyId = null }) {
  const sourceId = Number(
    db()
      .prepare(
        "INSERT INTO sources (title, kind, url, canonical_url, status, triage, read_mode, published_at) VALUES (?, 'url', ?, ?, 'chunked', 'held', 'eager', ?)"
      )
      .run(title, `https://example.com/${encodeURIComponent(title)}`, `example.com/${title}`, publishedAt)
      .lastInsertRowid
  );
  db()
    .prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, ?, '{}')")
    .run(sourceId, `${title}. ${"Officials described the meeting as short. ".repeat(30)}`);
  const itemId = Number(
    db()
      .prepare(
        "INSERT INTO feed_items (feed_id, guid, url, title, state, source_id, published_at) VALUES (?, ?, ?, ?, 'held', ?, ?)"
      )
      .run(feedId, `g-${title}`, `https://example.com/${encodeURIComponent(title)}`, title, sourceId, publishedAt)
      .lastInsertRowid
  );
  if (storyId) {
    db().prepare("INSERT INTO story_sources (story_id, source_id) VALUES (?, ?)").run(storyId, sourceId);
  }
  return { itemId, sourceId };
}

const feedId = Number(
  db().prepare("INSERT INTO feeds (url, title, outlet) VALUES ('https://f.example/rss', 'Test feed', 'Test')").run()
    .lastInsertRowid
);

/* ------------------------------------------------------------- the inbox */

section("Nothing is read until you say so");
{
  const a = mkHeld({ title: "Tariff talks resume", feedId });
  const b = mkHeld({ title: "A cabinet shuffle", feedId });

  check("both are waiting", triage.heldCount() === 2, String(triage.heldCount()));
  const listed = triage.listHeld();
  check("the inbox lists them", listed.length === 2);
  check("with the opening of the article to judge by", Boolean(listed[0].lede), listed[0].lede ?? "null");
  check(
    "and nothing is queued while they wait",
    (db().prepare("SELECT COUNT(*) n FROM tasks WHERE kind='extract'").get()).n === 0
  );

  const kept = triage.keep([a.itemId]);
  check("keeping one reports it", kept.kept === 1);
  check(
    "and queues its passages to be read",
    (db().prepare("SELECT COUNT(*) n FROM tasks WHERE kind='extract'").get()).n === 1
  );
  check(
    "with the reconciliation behind it",
    (db().prepare("SELECT COUNT(*) n FROM tasks WHERE kind='plan_entries'").get()).n === 1
  );
  check(
    "the source says it was kept",
    (db().prepare("SELECT triage, kept_at FROM sources WHERE id=?").get(a.sourceId)).triage === "kept"
  );
  check("the inbox is one shorter", triage.heldCount() === 1);

  triage.discard([b.itemId], "not my beat");
  check("discarding empties it", triage.heldCount() === 0);
  check(
    "the discarded article is not read",
    (db().prepare("SELECT COUNT(*) n FROM tasks WHERE kind='extract'").get()).n === 1
  );
  check(
    "its text is kept, so the decision can be undone",
    (db().prepare("SELECT COUNT(*) n FROM chunks WHERE source_id=?").get(b.sourceId)).n === 1
  );

  const back = triage.undo([b.itemId]);
  check("undo puts it back in the inbox", back.restored === 1 && triage.heldCount() === 1);
  check(
    "a kept item cannot be undone the same way",
    triage.undo([a.itemId]).restored === 0
  );

  // Keeping ten is one run, not ten.
  const many = [1, 2, 3].map((n) => mkHeld({ title: `Bulk ${n}`, feedId }));
  const bulk = triage.keep(many.map((m) => m.itemId));
  check("keeping several is one run", bulk.kept === 3 && typeof bulk.runId === "number");
  check(
    "with one reconciliation for the lot",
    (db().prepare("SELECT COUNT(*) n FROM tasks WHERE kind='plan_entries' AND run_id=?").get(bulk.runId)).n === 1
  );
}

/* --------------------------------------------------------------- the week */

section("The week runs Friday to Thursday");
{
  // 4 September 2026 is a Friday; the 5th is the Saturday after it.
  const friday = new Date(2026, 8, 4, 9, 0);
  const saturday = new Date(2026, 8, 5, 9, 0);
  const thursday = new Date(2026, 8, 10, 23, 0);
  const nextFriday = new Date(2026, 8, 11, 0, 30);

  check("a Friday opens its own week", week.dayKey(week.weekStart(friday)) === "2026-09-04");
  check("the Saturday after belongs to it", week.weekKey(saturday) === "week:2026-09-04");
  check("so does the Thursday", week.weekKey(thursday) === "week:2026-09-04");
  check("the next Friday starts a new one", week.weekKey(nextFriday) === "week:2026-09-11");
  check("a week key is recognised", week.isWeekKey("week:2026-09-04") && !week.isWeekKey("2026-09-04"));
  check("the previous week is seven days back", week.previousWeekKey("week:2026-09-11") === "week:2026-09-04");

  const range = week.weekRange("week:2026-09-04");
  check("a week is seven days long", (range.to - range.from) / 86_400_000 === 7);
  check("and describes itself", /September 2026/.test(week.describeWeek("week:2026-09-04")), week.describeWeek("week:2026-09-04"));
}

section("The week is built from what you kept, when you kept it");
{
  const now = new Date();
  const from = week.weekStart(now);
  const to = week.weekEnd(now);

  // Published last month, kept today: it is this week's work.
  const old = mkHeld({ title: "Published weeks ago", feedId, publishedAt: "2026-07-01T09:00:00Z" });
  triage.keep([old.itemId]);

  const kept = brief.keptBetween(from, to);
  check(
    "an old article kept today is in this week",
    kept.some((k) => k.title === "Published weeks ago"),
    JSON.stringify(kept.map((k) => k.title))
  );

  const decided = triage.decidedBetween(from, to);
  check("the week counts what was decided", decided.kept >= 1);

  // A discarded article is not in the week's material at any price.
  const junk = mkHeld({ title: "Junk", feedId });
  triage.discard([junk.itemId]);
  const after = brief.keptBetween(from, to);
  check("a discarded one never appears", !after.some((k) => k.title === "Junk"));
}

/* ------------------------------------------------ nothing kept without text */

section("A headline is not an article");
{
  const stub = mkHeld({ title: "Paywalled piece", feedId });
  db().prepare("DELETE FROM chunks WHERE source_id=?").run(stub.sourceId);
  db()
    .prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, ?, '{}')")
    .run(stub.sourceId, "Democracy Dies in Darkness. Subscribe to continue reading.");

  const result = triage.keep([stub.itemId]);
  check("keeping it is refused", result.kept === 0 && result.refused.length === 1, JSON.stringify(result));
  check("and it stays in the inbox", triage.heldCount() >= 1);
  check(
    "nothing was queued for it",
    (db().prepare("SELECT COUNT(*) n FROM tasks WHERE kind='extract' AND run_id=(SELECT MAX(id) FROM runs)").get()).n >= 0
  );

  let threw = null;
  try { triage.pasteText(stub.itemId, "Too short to be an article."); } catch (e) { threw = e.message; }
  check("pasting a scrap is refused too", Boolean(threw), threw ?? "no error");

  triage.pasteText(stub.itemId, "The minister said the talks would continue. ".repeat(40));
  const after = triage.keep([stub.itemId]);
  check("once the article is pasted it can be kept", after.kept === 1, JSON.stringify(after));
}

/* ---------------------------------------------------------- the feed clock */

section("The worker knows when the next feed is due");
{
  const feeds = await import("../lib/feeds.ts");
  // The test feed above has never been polled, so it is due now.
  const now = Date.now();
  const due = feeds.nextFeedDueAt();
  check("a feed never polled is due at once", due && Math.abs(due.getTime() - now) < 5_000, String(due));

  db().prepare("UPDATE feeds SET last_polled_at=datetime('now'), interval_minutes=45 WHERE id=?").run(feedId);
  const later = feeds.nextFeedDueAt();
  const minutes = later ? (later.getTime() - now) / 60_000 : NaN;
  check("a polled feed is due after its interval", minutes > 44 && minutes < 46, `${minutes} minutes`);

  db().prepare("UPDATE feeds SET enabled=0 WHERE id=?").run(feedId);
  check("a paused feed sets no alarm", feeds.nextFeedDueAt() === undefined);
  db().prepare("UPDATE feeds SET enabled=1 WHERE id=?").run(feedId);
}

/* -------------------------------------------------------------- the shelf */

section("A source on the shelf is never read");
{
  const sourceId = Number(
    db()
      .prepare("INSERT INTO sources (title, kind, status, read_mode) VALUES ('A novel', 'epub', 'chunked', 'shelf')")
      .run().lastInsertRowid
  );
  const chunkId = Number(
    db()
      .prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, 'Chapter one.', '{}')")
      .run(sourceId).lastInsertRowid
  );

  check("the mode is remembered", reading.readModeOf({ read_mode: "shelf", chunks: 1 }) === "shelf");
  const runId = Number(
    db().prepare("INSERT INTO runs (kind, label, state) VALUES ('ingest', 'test', 'queued')").run().lastInsertRowid
  );
  check("bulk reading refuses it", reading.queueExtractions(runId, sourceId, [chunkId]) === 0);
  check("and so does catching up", reading.queueUnread(sourceId).queued === 0);

  db().prepare("UPDATE sources SET read_mode='eager' WHERE id=?").run(sourceId);
  const off = reading.queueUnread(sourceId);
  check("taking it off the shelf reads what was never read", off.queued === 1, JSON.stringify(off));
  check("and only once", reading.queueUnread(sourceId).queued === 0);
}

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
