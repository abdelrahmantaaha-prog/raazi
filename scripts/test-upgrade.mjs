/**
 * Rewriting the library with a stronger writer.
 *
 * What is worth protecting: one entry at a time and only in the quiet, the
 * most important first, never one the target model already wrote, never while
 * that model is spent or the run is paused — and it settles instead of looping.
 *
 *   npx tsx scripts/test-upgrade.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__upgrade__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.env.CORPUS_DATA_DIR = SANDBOX;
process.env.CORPUS_WORKER_IDLE_MS = "150";
process.env.CORPUS_TEST_UPGRADE = "1";

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

const OPUS = "claude-opus-5-5";
saveConfig({ autoRefreshEntries: false, morningChores: false, dailyBrief: false, feedPolling: false });

const sourceId = Number(
  db().prepare("INSERT INTO sources (title, kind, status) VALUES ('S','text','ready')").run().lastInsertRowid
);
const chunkId = Number(
  db().prepare("INSERT INTO chunks (source_id, seq, text) VALUES (?, 0, 'text')").run(sourceId).lastInsertRowid
);

const makeEntry = (name, mentions, model, opts = {}) => {
  const id = Number(
    db()
      .prepare(
        "INSERT INTO entities (type, canonical_name, normalized, entry_state, starred) VALUES ('person', ?, ?, 'fresh', ?)"
      )
      .run(name, name.toLowerCase(), opts.starred ? 1 : 0).lastInsertRowid
  );
  for (let i = 0; i < mentions; i++) {
    db()
      .prepare("INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote) VALUES (?,?,?,?,?)")
      .run(id, chunkId, sourceId, name, `quote ${i}`);
  }
  db()
    .prepare("INSERT INTO entries (entity_id, summary, body_md, built_from_hash, model) VALUES (?,?,?,?,?)")
    .run(id, "s", "b", "h", model);
  return id;
};

const few = makeEntry("Few", 2, null);
const many = makeEntry("Many", 9, "gemini-3.5-flash");
const star = makeEntry("Star", 1, null, { starred: true });
const done = makeEntry("Done", 20, OPUS);
const orphan = makeEntry("Orphan", 0, null);

// What the real handler does on success: the entry now carries its writer.
const written = [];
const writer = (model) => ({
  async entry(task) {
    const p = JSON.parse(task.payload_json);
    written.push(p);
    db().prepare("UPDATE entries SET model=? WHERE entity_id=?").run(model, p.entityId);
    queue.finishTask(task.id, task.run_id, { tokensIn: 10, tokensOut: 5 });
  },
});

// ---------------------------------------------------------------------------
section("Off unless asked, and only through the plan");
// ---------------------------------------------------------------------------
check("nothing to do while the setting is off", entries.queueUpgrade(() => false) === false);
saveConfig({ upgradeEntriesTo: OPUS, routing: { entry: "gemini" } });
check("nothing while entries are written by another provider", entries.queueUpgrade(() => false) === false);
saveConfig({ routing: { entry: "claude-code" } });
check("nothing while the model is spent", entries.queueUpgrade(() => true) === false);
check("counts what is left, skipping the done and the evidence-less", entries.upgradeRemaining(OPUS) === 3,
  String(entries.upgradeRemaining(OPUS)));

// ---------------------------------------------------------------------------
section("One at a time, most important first");
// ---------------------------------------------------------------------------
check("queues one", entries.queueUpgrade(() => false) === true);
check("and not a second while it is in flight", entries.queueUpgrade(() => false) === false);
const pending = db().prepare("SELECT payload_json FROM tasks WHERE state='pending'").all();
check("exactly one task waits", pending.length === 1, String(pending.length));
const first = JSON.parse(pending[0].payload_json);
check("the starred entry goes first", first.entityId === star, JSON.stringify(first));
check("forced, and marked as an upgrade", first.force === true && first.upgrade === true);
check("the stale-entry refresh does not mistake it for its own", !entries.refreshInFlight());

await startWorker(writer(OPUS));
check(
  "the worker trickles through the rest, best-sourced next",
  JSON.stringify(written.map((p) => p.entityId)) === JSON.stringify([star, many, few]),
  JSON.stringify(written.map((p) => p.entityId))
);
check("never the one already written by the target", !written.some((p) => p.entityId === done));
check("never one with no evidence", !written.some((p) => p.entityId === orphan));
check("nothing left", entries.upgradeRemaining(OPUS) === 0);
const runs = db().prepare("SELECT COUNT(*) AS n FROM runs WHERE kind=?").get(entries.UPGRADE_RUN_KIND).n;
check("all in one run, reopened each time", runs === 1, String(runs));

// ---------------------------------------------------------------------------
section("It settles");
// ---------------------------------------------------------------------------
const before = db().prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
await startWorker(writer(OPUS));
check("a second idle pass queues nothing", db().prepare("SELECT COUNT(*) AS n FROM tasks").get().n === before);

// Answered by a fallback: the entry still is not Opus's, but it was tried today.
const stubborn = makeEntry("Stubborn", 5, null);
globalThis.__corpusWorker.upgradedAt = undefined; // the minute between looks, skipped
written.length = 0;
await startWorker(writer("gemini-3.8-flash"));
check("an entry a fallback answered is tried once", written.length === 1 && written[0].entityId === stubborn,
  JSON.stringify(written));
check("and then left for a day rather than looped", entries.queueUpgrade(() => false) === false);

// ---------------------------------------------------------------------------
section("Pausing the run pauses the upgrade");
// ---------------------------------------------------------------------------
makeEntry("Later", 3, null);
const run = db().prepare("SELECT id FROM runs WHERE kind=?").get(entries.UPGRADE_RUN_KIND).id;
db().prepare("UPDATE runs SET state='paused_user' WHERE id=?").run(run);
check("nothing is queued into a run you paused", entries.queueUpgrade(() => false) === false);
db().prepare("UPDATE runs SET state='done' WHERE id=?").run(run);
check("and it goes on once resumed", entries.queueUpgrade(() => false) === true);

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
