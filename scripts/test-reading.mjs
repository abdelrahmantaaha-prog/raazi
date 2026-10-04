/**
 * Reading position, read-along extraction, bookmarks and the dictionary.
 *
 * These are the parts that were broken in ways that looked like nothing was
 * happening rather than like an error: progress stuck at zero, a bookmark that
 * saved and never came back. So they get tested against a real database rather
 * than reasoned about.
 *
 * Runs against a scratch database. No API key needed.
 *
 *   node scripts/test-reading.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_reading__");
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
const {
  readModeOf,
  guessReadMode,
  recordPosition,
  resetPosition,
  readAlong,
  queueExtractions,
  pendingCount,
  markRead,
  markReadThrough,
  readPassages,
  partlyRead,
} = await import("../lib/reading.ts");

/** A source with `n` passages, none of them read. */
function makeSource(title, n, readMode = null) {
  const id = Number(
    db()
      .prepare("INSERT INTO sources (title, kind, status, read_mode) VALUES (?, 'text', 'ready', ?)")
      .run(title, readMode).lastInsertRowid
  );
  const stmt = db().prepare(
    "INSERT INTO chunks (source_id, seq, text, token_est, locator_json) VALUES (?, ?, ?, 100, '{}')"
  );
  const chunks = [];
  for (let i = 0; i < n; i++) {
    chunks.push(Number(stmt.run(id, i, `Passage ${i} of ${title}.`).lastInsertRowid));
  }
  return { id, chunks };
}

const pendingTasks = (sourceId) =>
  db()
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t JOIN runs r ON r.id=t.run_id
        WHERE r.source_id=? AND t.kind='extract' AND t.state='pending'`
    )
    .get(sourceId).n;

// ---------------------------------------------------------------------------
section("Deciding which sources are worth reading along with");
// ---------------------------------------------------------------------------
check("a book reads along", guessReadMode({ chunks: 200 }) === "along");
check("an article is swallowed whole", guessReadMode({ chunks: 2 }) === "eager");
check("so is a long-ish essay", guessReadMode({ chunks: 8 }) === "eager");
check("your choice overrides the guess", readModeOf({ chunks: 200, read_mode: "eager" }) === "eager");
check("and the other way", readModeOf({ chunks: 1, read_mode: "along" }) === "along");
check("no choice falls back to the guess", readModeOf({ chunks: 200 }) === "along");

// ---------------------------------------------------------------------------
section("Position is stored, and only ever moves forward");
// ---------------------------------------------------------------------------
{
  const { id, chunks } = makeSource("Position", 20, "along");

  // Progress is weighted by length, so a half-page passage does not count for
  // as much as a long one. The expected value therefore has to be computed
  // from the text rather than from a count of passages.
  const lengths = new Map(
    db()
      .prepare("SELECT id, LENGTH(text) AS n FROM chunks WHERE source_id=?")
      .all(id)
      .map((r) => [r.id, r.n])
  );
  const whole = [...lengths.values()].reduce((a, b) => a + b, 0);
  const share = (ids) => ids.reduce((a, i) => a + lengths.get(i), 0) / whole;

  recordPosition(id, { chunkId: chunks[5], offset: 0.4, read: [chunks[0], chunks[1]] });
  let row = db().prepare("SELECT * FROM sources WHERE id=?").get(id);
  check("the passage is remembered", row.bookmark_chunk === chunks[5]);
  check("so is how far into it", Math.abs(row.bookmark_offset - 0.4) < 1e-6);
  check("opening it counts as reading it", Boolean(row.read_at));

  // The point of the rework: progress is a fact about what you have read, so
  // it comes from the passages reported read and from nothing else. Scrolling
  // to the end of a book used to report the book as finished.
  check("progress counts read passages, not scroll position",
    Math.abs(row.progress - share([chunks[0], chunks[1]])) < 1e-6, String(row.progress));

  recordPosition(id, { chunkId: chunks[19], offset: 1, read: [] });
  row = db().prepare("SELECT * FROM sources WHERE id=?").get(id);
  check("racing to the last page does not finish the book",
    Math.abs(row.progress - share([chunks[0], chunks[1]])) < 1e-6, String(row.progress));

  // Scrolling back to check something on an earlier page must not un-read the
  // book. Without the ratchet, read-along would then re-queue everything.
  recordPosition(id, { chunkId: chunks[2], offset: 0.1, read: [] });
  row = db().prepare("SELECT * FROM sources WHERE id=?").get(id);
  check("scrolling back moves the position", row.bookmark_chunk === chunks[2]);
  check("but does not lower progress", Math.abs(row.progress - share([chunks[0], chunks[1]])) < 1e-6, String(row.progress));
  check(
    "and does not lower the high-water mark",
    row.furthest_chunk === chunks[19],
    String(row.furthest_chunk)
  );

  check("reading a passage twice counts it once", (() => {
    recordPosition(id, { chunkId: chunks[1], offset: 0, read: [chunks[0], chunks[1]] });
    const r = db().prepare("SELECT progress FROM sources WHERE id=?").get(id);
    return Math.abs(r.progress - share([chunks[0], chunks[1]])) < 1e-6;
  })());

  check("saying you have read this far counts everything before it", (() => {
    markReadThrough(id, chunks[9]);
    const r = db().prepare("SELECT progress FROM sources WHERE id=?").get(id);
    return Math.abs(r.progress - share(chunks.slice(0, 10))) < 1e-6;
  })());

  check("an offset outside the page is clamped", (() => {
    recordPosition(id, { chunkId: chunks[9], offset: 5, read: [] });
    return db().prepare("SELECT bookmark_offset FROM sources WHERE id=?").get(id).bookmark_offset === 1;
  })());

  resetPosition(id);
  row = db().prepare("SELECT * FROM sources WHERE id=?").get(id);
  check("starting over forgets all of it",
    row.progress === 0 && row.bookmark_chunk === null && row.furthest_chunk === null);
  check("including which passages were read", readPassages(id).length === 0);
}

// ---------------------------------------------------------------------------
section("Partway through a passage counts as partway");
// ---------------------------------------------------------------------------
// A passage of a real book averages several pages. Counting only whole ones,
// "Read to here" counted the rest of the passage you stopped in, and reading
// mode recorded nothing until a passage's last paragraph.
{
  const { id, chunks } = makeSource("Partway", 10, "along");
  // Equal lengths, so a share of the book is easy to state.
  db().prepare("UPDATE chunks SET text=? WHERE source_id=?").run("x".repeat(1000), id);
  const progress = () => db().prepare("SELECT progress FROM sources WHERE id=?").get(id).progress;

  markReadThrough(id, chunks[2], 0.3);
  check("read to here stops where you stopped", Math.abs(progress() - 0.23) < 1e-6, String(progress()));
  check("and the passage you stopped in is on the record",
    partlyRead(id)[chunks[2]] !== undefined && Math.abs(partlyRead(id)[chunks[2]] - 0.3) < 1e-6);
  check("the ones before it are not partway", partlyRead(id)[chunks[1]] === undefined);

  markReadThrough(id, chunks[2], 0.1);
  check("marking an earlier spot does not un-read anything", Math.abs(progress() - 0.23) < 1e-6, String(progress()));

  recordPosition(id, { chunkId: chunks[2], offset: 0.6, partly: [{ chunkId: chunks[2], share: 0.6 }] });
  check("reading on paragraph by paragraph moves it", Math.abs(progress() - 0.26) < 1e-6, String(progress()));

  recordPosition(id, { chunkId: chunks[3], offset: 0, read: [chunks[2]] });
  check("finishing the passage counts all of it", Math.abs(progress() - 0.3) < 1e-6, String(progress()));
  check("and it is no longer partway", partlyRead(id)[chunks[2]] === undefined);

  recordPosition(id, { chunkId: chunks[3], offset: 0, partly: [{ chunkId: chunks[3], share: 0 }] });
  check("nothing of a passage is not a row", !readPassages(id).includes(chunks[3]));

  markReadThrough(id, chunks[4]);
  check("without a share, through means the whole passage", Math.abs(progress() - 0.5) < 1e-6, String(progress()));
}

// ---------------------------------------------------------------------------
section("Read-along hands over only what you have read");
// ---------------------------------------------------------------------------
{
  const { id, chunks } = makeSource("Along", 30, "along");

  check("nothing is queued before you open it", pendingTasks(id) === 0);
  check("and every passage is still unread", pendingCount(id) === 30);

  // Scrolling alone releases nothing — the whole point of the rework. Racing
  // to the end of a book used to hand the entire book to the model at once.
  recordPosition(id, { chunkId: chunks[29], offset: 1, read: [] });
  check("scrolling to the end queues nothing", readAlong(id).queued === 0, String(pendingTasks(id)));

  // Reading through passage 4 releases 0..4 plus the two-passage lookahead.
  markRead(id, chunks.slice(0, 5), "read");
  const first = readAlong(id);
  check("reading five passages queues seven", first.queued === 7, String(first.queued));
  check("which is what the queue actually holds", pendingTasks(id) === 7, String(pendingTasks(id)));
  check("and it says how much is still ahead", first.remaining === 30, String(first.remaining));

  // The reader calls this on every scroll tick. It must be free to do so.
  const again = readAlong(id);
  check("calling it again having read no more queues nothing", again.queued === 0);
  check("the queue is unchanged", pendingTasks(id) === 7, String(pendingTasks(id)));

  markRead(id, chunks.slice(5, 11), "read");
  const onward = readAlong(id);
  check("reading further queues only the new stretch", onward.queued === 6, String(onward.queued));
  check("for thirteen in total", pendingTasks(id) === 13, String(pendingTasks(id)));

  check("re-reading an earlier passage queues nothing at all", readAlong(id).queued === 0);

  const runs = db()
    .prepare("SELECT COUNT(*) AS n FROM runs WHERE source_id=? AND kind='readalong'")
    .get(id).n;
  check("all of it accumulates in one run, not one per scroll", runs === 1, String(runs));

  // Resolution and entry-writing have to stay at the end, and there must be
  // exactly one copy of them however many batches were queued.
  const tail = db()
    .prepare(
      `SELECT t.kind, COUNT(*) AS n FROM tasks t JOIN runs r ON r.id=t.run_id
        WHERE r.source_id=? AND t.kind IN ('resolve','plan_entries') GROUP BY t.kind`
    )
    .all(id);
  const planEntries = tail.find((t) => t.kind === "plan_entries")?.n ?? 0;
  check("one plan_entries, not one per batch", planEntries === 1, String(planEntries));
  check(
    "and the tail sorts after every extraction",
    (() => {
      const lastExtract = db()
        .prepare(
          `SELECT MAX(t.seq) AS s FROM tasks t JOIN runs r ON r.id=t.run_id
            WHERE r.source_id=? AND t.kind='extract'`
        )
        .get(id).s;
      const firstTail = db()
        .prepare(
          `SELECT MIN(t.seq) AS s FROM tasks t JOIN runs r ON r.id=t.run_id
            WHERE r.source_id=? AND t.kind IN ('resolve','plan_entries')`
        )
        .get(id).s;
      return firstTail > lastExtract;
    })()
  );
}

// ---------------------------------------------------------------------------
section("An eager source is not touched by any of this");
// ---------------------------------------------------------------------------
{
  const { id, chunks } = makeSource("Eager", 4, "eager");
  markRead(id, chunks, "read");
  check("read-along declines to queue anything", readAlong(id).queued === 0);
  check("because ingest already did", pendingTasks(id) === 0);

  const runId = Number(
    db().prepare("INSERT INTO runs (source_id, kind, state) VALUES (?, 'ingest', 'queued')").run(id)
      .lastInsertRowid
  );
  const queued = queueExtractions(runId, id, chunks);
  check("ingest queues the whole thing at once", queued === 4, String(queued));
  check("and stamps them so nothing queues them twice", (() => {
    const n = db()
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE source_id=? AND queued_at IS NOT NULL")
      .get(id).n;
    return n === 4;
  })());
}

// ---------------------------------------------------------------------------
section("Ingest leaves a read-along book alone");
// ---------------------------------------------------------------------------
{
  const { id, chunks } = makeSource("Big book", 40, "along");
  const runId = Number(
    db().prepare("INSERT INTO runs (source_id, kind, state) VALUES (?, 'ingest', 'queued')").run(id)
      .lastInsertRowid
  );
  check("nothing is queued at ingest", queueExtractions(runId, id, chunks) === 0);
  check(
    "and no passage is stamped, so reading can release them",
    db().prepare("SELECT COUNT(*) AS n FROM chunks WHERE source_id=? AND queued_at IS NOT NULL").get(id)
      .n === 0
  );
}

// ---------------------------------------------------------------------------
section("Bookmarks are decisions, and persist like one");
// ---------------------------------------------------------------------------
{
  const { id, chunks } = makeSource("Marked", 12, "along");
  const add = db().prepare(
    "INSERT INTO bookmarks (source_id, chunk_id, offset, excerpt) VALUES (?, ?, ?, ?)"
  );
  add.run(id, chunks[3], 0.2, "The first thing worth remembering.");
  add.run(id, chunks[7], 0.5, "The second.");

  const marks = db()
    .prepare("SELECT b.*, c.seq FROM bookmarks b JOIN chunks c ON c.id=b.chunk_id WHERE b.source_id=? ORDER BY c.seq")
    .all(id);
  check("more than one bookmark per source", marks.length === 2);
  check("in reading order", marks[0].seq === 3 && marks[1].seq === 7);
  check("carrying the words you marked", marks[0].excerpt.startsWith("The first"));

  // The resume position is overwritten constantly; bookmarks must not be.
  recordPosition(id, { chunkId: chunks[11], offset: 0.9, progress: 0.95 });
  check(
    "reading on does not disturb them",
    db().prepare("SELECT COUNT(*) AS n FROM bookmarks WHERE source_id=?").get(id).n === 2
  );

  db().prepare("DELETE FROM sources WHERE id=?").run(id);
  check(
    "removing the source takes its bookmarks with it",
    db().prepare("SELECT COUNT(*) AS n FROM bookmarks WHERE source_id=?").get(id).n === 0
  );
}

// ---------------------------------------------------------------------------
section("The dictionary asks the right Wiktionary and cleans the word first");
// ---------------------------------------------------------------------------
{
  const { editionFor, normaliseWord } = await import("../lib/dictionary.ts");

  check("Arabic goes to the Arabic edition", editionFor("كتاب") === "ar");
  check("English to the English one", editionFor("polity") === "en");
  check("punctuation is stripped from a selection", normaliseWord("“polity,”") === "polity");
  check("so are Arabic diacritics", normaliseWord("كِتَابٌ") === "كتاب", normaliseWord("كِتَابٌ"));
  check("hyphenated words survive intact", normaliseWord("well-being") === "well-being");
  check("and an empty selection stays empty", normaliseWord("  “ ” ") === "");
}

// ---------------------------------------------------------------------------
section("YouTube links, without an API key");
// ---------------------------------------------------------------------------
{
  const { videoId, thumbnailUrl } = await import("../lib/youtube.ts");

  check("a watch URL", videoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ") === "dQw4w9WgXcQ");
  check("a short link", videoId("https://youtu.be/dQw4w9WgXcQ") === "dQw4w9WgXcQ");
  check("with a timestamp on it", videoId("https://youtu.be/dQw4w9WgXcQ?t=42") === "dQw4w9WgXcQ");
  check("an embed", videoId("https://www.youtube.com/embed/dQw4w9WgXcQ") === "dQw4w9WgXcQ");
  check("a short", videoId("https://www.youtube.com/shorts/dQw4w9WgXcQ") === "dQw4w9WgXcQ");
  check("a live stream", videoId("https://www.youtube.com/live/dQw4w9WgXcQ") === "dQw4w9WgXcQ");
  check("not some other site", videoId("https://vimeo.com/12345") === null);
  check("not a bare string", videoId("dQw4w9WgXcQ") === null);
  check("and not a channel page", videoId("https://www.youtube.com/@someone") === null);
  check(
    "the still is the one that always exists",
    thumbnailUrl("abc123").endsWith("/hqdefault.jpg"),
    thumbnailUrl("abc123")
  );
}

// ---------------------------------------------------------------------------
section("The name sweep finds appearances extraction walked past");
// ---------------------------------------------------------------------------
{
  const { sweepSource } = await import("../lib/pipeline/sweep.ts");

  const sid = Number(
    db()
      .prepare("INSERT INTO sources (title, kind, status) VALUES ('Sweep book','text','ready')")
      .run().lastInsertRowid
  );

  const chunkStmt = db().prepare(
    "INSERT INTO chunks (source_id, seq, text, token_est, locator_json, extracted_at)" +
      " VALUES (?, ?, ?, 50, '{}', datetime('now'))"
  );
  const mk = (seq, text) => Number(chunkStmt.run(sid, seq, text).lastInsertRowid);

  const c0 = mk(0, "Benjamin Netanyahu returned to office in 2022. He named a cabinet.");
  const c1 = mk(1, "The coalition held. Netanyahu addressed the Knesset about the budget that week.");
  const c2 = mk(2, "Nothing here names anybody at all, it is only scenery and weather.");
  const c3 = mk(3, "ذكر بنيامين نتنياهو في خطابه أن الميزانية سوف تمر بسهولة.");

  const ent = Number(
    db()
      .prepare(
        "INSERT INTO entities (type, canonical_name, normalized) VALUES ('person','Benjamin Netanyahu','benjamin netanyahu')"
      )
      .run().lastInsertRowid
  );
  const aliasStmt = db().prepare(
    "INSERT OR IGNORE INTO aliases (entity_id, surface, normalized) VALUES (?, ?, ?)"
  );
  for (const a of ["Benjamin Netanyahu", "Netanyahu", "بنيامين نتنياهو"]) {
    aliasStmt.run(ent, a, a.toLowerCase());
  }

  // Extraction found him in the first passage only — the reported failure.
  const mentionStmt = db().prepare(
    "INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote) VALUES (?, ?, ?, ?, ?)"
  );
  mentionStmt.run(ent, c0, sid, "Benjamin Netanyahu", "Benjamin Netanyahu returned to office in 2022.");

  const added = sweepSource(sid);
  check("it finds the passages that were skipped", added === 2, String(added));

  const rows = db()
    .prepare("SELECT chunk_id, surface, quote, confidence FROM mentions WHERE entity_id=? ORDER BY chunk_id")
    .all(ent);
  check("one mention per passage, never two", rows.length === 3, String(rows.length));
  check(
    "it does not disturb the passage already recorded",
    rows.find((r) => r.chunk_id === c0).confidence === 1
  );
  check("a shortened surname counts as an appearance", Boolean(rows.find((r) => r.chunk_id === c1)));
  check("and so does the Arabic form", Boolean(rows.find((r) => r.chunk_id === c3)));
  check("a passage naming nobody stays empty", !rows.find((r) => r.chunk_id === c2));
  check(
    "found mentions are marked as weaker evidence",
    rows.filter((r) => r.chunk_id !== c0).every((r) => r.confidence === 0.8)
  );

  // The guarantee that makes this safe to run unattended.
  const found = rows.filter((r) => r.chunk_id !== c0);
  check(
    "every quote it writes is verbatim from its passage",
    found.every((r) => {
      const t = db().prepare("SELECT text FROM chunks WHERE id=?").get(r.chunk_id).text;
      return t.includes(r.quote);
    })
  );
  check("the quote is a sentence, not the whole passage", found.every((r) => r.quote.length < 200));
  check("a second sweep costs nothing and changes nothing", sweepSource(sid) === 0);

  // A name two entities both answer to identifies neither — the same lesson as
  // the merge bug, applied before anything is written rather than after.
  const other = Number(
    db()
      .prepare(
        "INSERT INTO entities (type, canonical_name, normalized) VALUES ('person','Iddo Netanyahu','iddo netanyahu')"
      )
      .run().lastInsertRowid
  );
  aliasStmt.run(other, "Netanyahu", "netanyahu");
  mentionStmt.run(other, c0, sid, "Iddo Netanyahu", "Iddo Netanyahu is his brother.");

  const c4 = mk(4, "Later that year Netanyahu spoke again, at length, about the very same budget.");
  sweepSource(sid);
  const ambiguous = db()
    .prepare("SELECT COUNT(*) AS n FROM mentions WHERE chunk_id=? AND surface='Netanyahu'")
    .get(c4).n;
  check("an ambiguous name is filed against nobody", ambiguous === 0, String(ambiguous));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
