/**
 * Keeping entries current.
 *
 * The property worth protecting: an entry that exists is always brought back in
 * line with its evidence, whatever the entity's size. The mention threshold only
 * decides whether a *first* entry is worth writing.
 *
 *   npx tsx scripts/test-refresh.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__refresh__");
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
const { saveConfig } = await import("../lib/config.ts");
const entries = await import("../lib/entries.ts");
const queue = await import("../lib/queue.ts");
const { startWorker } = await import("../lib/worker.ts");

saveConfig({ entryThreshold: 3, autoRefreshEntries: true });

const sourceId = Number(
  db().prepare("INSERT INTO sources (title, kind, status) VALUES ('S','text','ready')").run()
    .lastInsertRowid
);
const chunkId = Number(
  db().prepare("INSERT INTO chunks (source_id, seq, text) VALUES (?, 0, 'text')").run(sourceId)
    .lastInsertRowid
);

const makeEntity = (name, mentions, opts = {}) => {
  const id = Number(
    db()
      .prepare(
        "INSERT INTO entities (type, canonical_name, normalized, entry_state, starred) VALUES ('person', ?, ?, ?, ?)"
      )
      .run(name, name.toLowerCase(), opts.state ?? "stale", opts.starred ? 1 : 0).lastInsertRowid
  );
  for (let i = 0; i < mentions; i++) {
    db()
      .prepare(
        "INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote) VALUES (?,?,?,?,?)"
      )
      .run(id, chunkId, sourceId, name, `quote ${i}`);
  }
  if (opts.entry) {
    db()
      .prepare("INSERT INTO entries (entity_id, summary, body_md, built_from_hash) VALUES (?,?,?,?)")
      .run(id, "s", "b", "oldhash");
  }
  return id;
};

// ---------------------------------------------------------------------------
section("Which entries need rewriting");
// ---------------------------------------------------------------------------
const small = makeEntity("Small", 1, { entry: true });   // has an entry, below threshold
const big = makeEntity("Big", 5);                         // no entry, above threshold
const tiny = makeEntity("Tiny", 1);                       // no entry, below threshold
const starred = makeEntity("Starred", 1, { starred: true });
const fresh = makeEntity("Fresh", 4, { state: "fresh", entry: true });
const orphan = makeEntity("Orphan", 0, { entry: true });  // evidence all gone

const ids = entries.staleEntities().map((e) => e.id);

check(
  "an entry below the threshold is still kept current — the bug this fixes",
  ids.includes(small),
  JSON.stringify(ids)
);
check("an entity big enough earns its first entry", ids.includes(big));
check("a starred entity is included whatever its size", ids.includes(starred));
check("a small entity with no entry is left alone", !ids.includes(tiny));
check("an entry already matching its evidence is not rewritten", !ids.includes(fresh));
check(
  "an entity whose evidence has all gone is skipped, so the sweep can settle",
  !ids.includes(orphan)
);

const counts = entries.staleCount();
check(
  "the counts distinguish rewrites from new entries",
  counts.rewrites === 1 && counts.newEntries === 2,
  JSON.stringify(counts)
);

// ---------------------------------------------------------------------------
section("The sweep picks up staleness that no ingest caused");
// ---------------------------------------------------------------------------
check("nothing is queued yet", !entries.refreshInFlight());

const written = [];
await startWorker({
  async entry(task) {
    const { entityId } = JSON.parse(task.payload_json);
    written.push(entityId);
    // What the real handler does on success.
    db().prepare("UPDATE entities SET entry_state='fresh' WHERE id=?").run(entityId);
    queue.finishTask(task.id, task.run_id, { tokensIn: 10, tokensOut: 5 });
  },
});

check(
  "an idle worker rewrote everything out of date, with no ingest involved",
  written.length === 3 && [small, big, starred].every((id) => written.includes(id)),
  JSON.stringify(written)
);
check("and nothing is left stale", entries.staleEntities().length === 0);

// ---------------------------------------------------------------------------
section("It settles instead of looping");
// ---------------------------------------------------------------------------
const before = db().prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
await startWorker({ async entry() {} });
const after = db().prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
check("a second idle pass queues nothing new", after === before, `${before} -> ${after}`);

// A stale entity with no evidence must not keep the sweep spinning.
db().prepare("UPDATE entities SET entry_state='stale' WHERE id=?").run(orphan);
await startWorker({ async entry() {} });
check(
  "an entity with no evidence never gets queued, however stale",
  db().prepare("SELECT COUNT(*) AS n FROM tasks").get().n === after
);

// ---------------------------------------------------------------------------
section("Turning it off");
// ---------------------------------------------------------------------------
saveConfig({ autoRefreshEntries: false });
db().prepare("UPDATE entities SET entry_state='stale' WHERE id=?").run(small);
const beforeOff = db().prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
await startWorker({ async entry() {} });
check(
  "with automatic updates off, the sweep stays out of the way",
  db().prepare("SELECT COUNT(*) AS n FROM tasks").get().n === beforeOff
);
check("but asking explicitly still works", entries.queueStaleEntries()?.queued === 1);

// ---------------------------------------------------------------------------
section("Each ingest plans only what is not already waiting");
// ---------------------------------------------------------------------------
// Seventeen news articles once queued 4,630 entries for 337 entities: every
// planning step queued the whole stale backlog again, and each copy found a
// quote the last article had added and wrote the entry again.
const { handlers } = await import("../lib/pipeline/handlers.ts");
db().prepare("UPDATE entities SET entry_state='stale' WHERE id IN (?, ?)").run(big, starred);
const plan = async (label) => {
  const runId = queue.createRun({ kind: "ingest", label });
  queue.enqueue(runId, [{ kind: "plan_entries", payload: {} }]);
  await handlers.plan_entries(
    db().prepare("SELECT * FROM tasks WHERE run_id=? AND kind='plan_entries'").get(runId)
  );
  return runId;
};
const waiting = (id) =>
  db()
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE kind='entry' AND state='pending'
          AND json_extract(payload_json, '$.entityId') = ?`
    )
    .get(id).n;
const queuedIn = (runId) =>
  db().prepare("SELECT COUNT(*) AS n FROM tasks WHERE run_id=? AND kind='entry'").get(runId).n;

const first = await plan("First article");
check(
  "the first plan queues what is stale and not yet waiting",
  queuedIn(first) === 2 && waiting(big) === 1 && waiting(starred) === 1,
  `queued ${queuedIn(first)}`
);
check("an entity already waiting from the explicit refresh is not queued twice", waiting(small) === 1);
const second = await plan("Second article");
check("a second article's plan queues nothing already waiting", queuedIn(second) === 0, `queued ${queuedIn(second)}`);

queue.pauseRun(first, "paused_user", "Paused by you.");
const third = await plan("Third article");
check(
  "a run you paused does not hold its entities back from the next plan",
  queuedIn(third) === 2,
  `queued ${queuedIn(third)}`
);

// ---------------------------------------------------------------------------
section("The idle loop does not keep rereading the task table");
// ---------------------------------------------------------------------------
// Entries parked in a paused run keep "is a refresh in flight?" true for days.
// The look was made before the once-a-minute stamp, so an idle worker scanned
// all 140,000 tasks on every pass, several looks a pass (8 Nov 2026).
db().prepare("UPDATE tasks SET state='done' WHERE run_id <> ?").run(first);
saveConfig({ autoRefreshEntries: true });
{
  const conn = db();
  const realPrepare = conn.prepare;
  const seen = [];
  conn.prepare = function (sql) {
    seen.push(sql);
    return realPrepare.call(this, sql);
  };
  const s = globalThis.__corpusWorker;
  s.sweptAt = undefined;
  s.idleSince = Date.now();
  await startWorker({ async entry() {} });
  delete conn.prepare;
  const count = (needle) => seen.filter((q) => q.includes(needle)).length;
  const passes = count("ORDER BY");
  check("the idle loop made several passes", passes >= 2, `${passes}`);
  check("and asked about refreshes once, not every pass", count("t.kind IN ('entry', 'plan_entries')") === 1, String(count("t.kind IN ('entry', 'plan_entries')")));

  const usesIndex = (sql) => !/SCAN (tasks|t)\b/.test(db().prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join("; "));
  check(
    "whether a refresh is open is answered from the open tasks alone",
    usesIndex(`SELECT COUNT(*) AS n FROM tasks t WHERE t.kind IN ('entry', 'plan_entries') AND t.state IN ('pending', 'running') AND json_extract(t.payload_json, '$.upgrade') IS NULL`)
  );
  check(
    "as is whether a poll or a brief is",
    usesIndex(`SELECT COUNT(*) AS n FROM tasks WHERE kind IN ('poll', 'plan_polls', 'fetch_item') AND state IN ('pending','running')`) &&
      usesIndex(`SELECT COUNT(*) AS n FROM tasks WHERE kind='brief' AND state IN ('pending','running')`)
  );
}

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
