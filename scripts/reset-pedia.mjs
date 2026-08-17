/**
 * Starts the pedia over, keeping the library.
 *
 * Removes everything *derived* — entities, the quotes behind them, relations,
 * events, written entries and their history, and every judgement the resolver
 * has made — along with all reading progress. What it keeps is everything you
 * put in yourself: the sources and their text, your topics, your drafts, your
 * bookmarks and your study cards.
 *
 * Sources are marked unread rather than deleted, so a book is immediately
 * readable and gets re-indexed as you read it.
 *
 *   node scripts/reset-pedia.mjs           # show what would go
 *   node scripts/reset-pedia.mjs --confirm # do it
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const { db } = await import("../lib/db/index.ts");
const d = db();

const count = (sql) => {
  try {
    return d.prepare(sql).get().n;
  } catch {
    return 0;
  }
};

const before = {
  entities: count("SELECT COUNT(*) n FROM entities"),
  mentions: count("SELECT COUNT(*) n FROM mentions"),
  entries: count("SELECT COUNT(*) n FROM entries"),
  relations: count("SELECT COUNT(*) n FROM relations"),
  events: count("SELECT COUNT(*) n FROM events"),
  revisions: count("SELECT COUNT(*) n FROM entry_revisions"),
  verdicts: count("SELECT COUNT(*) n FROM resolution_verdicts"),
  merges: count("SELECT COUNT(*) n FROM merge_log"),
  readPassages: count("SELECT COUNT(*) n FROM read_passages"),
  runs: count("SELECT COUNT(*) n FROM runs"),
};

const kept = {
  sources: count("SELECT COUNT(*) n FROM sources"),
  passages: count("SELECT COUNT(*) n FROM chunks"),
  topics: count("SELECT COUNT(*) n FROM tags"),
  drafts: count("SELECT COUNT(*) n FROM drafts"),
  bookmarks: count("SELECT COUNT(*) n FROM bookmarks"),
  cards: count("SELECT COUNT(*) n FROM cards"),
};

console.log("Would remove:");
for (const [k, v] of Object.entries(before)) console.log(`  ${String(v).padStart(7)}  ${k}`);
console.log("\nWould keep:");
for (const [k, v] of Object.entries(kept)) console.log(`  ${String(v).padStart(7)}  ${k}`);

if (!process.argv.includes("--confirm")) {
  console.log("\nNothing changed. Re-run with --confirm to go ahead.");
  process.exit(0);
}

/**
 * Foreign keys off for the duration.
 *
 * `entities.merged_into` points back at `entities(id)` with ON DELETE SET NULL
 * and no index behind it, so SQLite rescans the whole table for every row it
 * removes: eleven thousand deletions became a hundred and forty million scans
 * and ran for eleven minutes without finishing. Every table that could be
 * orphaned is emptied here anyway, so the checks have nothing left to protect.
 */
d.pragma("foreign_keys = OFF");

d.transaction(() => {
  // Order still runs children first, so this remains correct if it is ever
  // used on a subset rather than on everything.
  for (const table of [
    "entry_revisions",
    "contradictions",
    "entries",
    "events",
    "relations",
    "mentions",
    "aliases",
    "entity_tags",
    "entities",
    "merge_log",
    "resolution_verdicts",
    "read_passages",
    "tasks",
    "runs",
  ]) {
    try {
      d.prepare(`DELETE FROM ${table}`).run();
    } catch (err) {
      console.warn(`  (skipped ${table}: ${err.message})`);
    }
  }

  // Every passage becomes unread, so reading a book indexes it again.
  d.prepare("UPDATE chunks SET extracted_at=NULL, queued_at=NULL, skip_reason=NULL").run();

  // And every source goes back to the start.
  d.prepare(
    `UPDATE sources
        SET status='ready', progress=0, bookmark_chunk=NULL, bookmark_offset=NULL,
            furthest_chunk=NULL, read_at=NULL, reading_state=NULL`
  ).run();

  // Study cards keep their own copied quote, so they survive their evidence.
  d.prepare("UPDATE cards SET entity_id=NULL, mention_id=NULL").run();
  // Gathered material likewise: the text was copied in, only the links go.
  d.prepare("UPDATE draft_notes SET entity_id=NULL, mention_id=NULL, chunk_id=NULL").run();
  d.prepare("UPDATE draft_citations SET mention_id=NULL").run();
})();

d.pragma("foreign_keys = ON");

// A wiped database is mostly free space; hand it back to the disk.
const sizeBefore = fs.statSync("data/corpus.db").size;
d.exec("VACUUM");
const sizeAfter = fs.statSync("data/corpus.db").size;

console.log("\nDone.");
console.log(
  `  database ${(sizeBefore / 1e6).toFixed(1)} MB → ${(sizeAfter / 1e6).toFixed(1)} MB`
);
console.log(`  ${kept.sources} sources and ${kept.passages} passages kept, all marked unread.`);
