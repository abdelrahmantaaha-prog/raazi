/**
 * The repairs from the 2026-08-15 audit, each tested at the level it failed.
 *
 * The config store is exercised with real files because its failure was a real
 * file — truncated JSON followed by a swallowed parse error persisted an empty
 * ring over thirty-seven keys. Crash recovery is exercised with a real second
 * process, because "is some other process alive" is the entire question. The
 * chunk split is driven against a real database because its bug was a SQL
 * ordering tie no unit stub would reproduce.
 *
 *   node scripts/test-hardening.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_hardening__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.env.CORPUS_DATA_DIR = SANDBOX;

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

const { readStore, writeStore } = await import("../lib/config-file.ts");
const { asId, readBody } = await import("../lib/http.ts");
const { db, DATA_DIR } = await import("../lib/db/index.ts");
const { splitTask } = await import("../lib/worker.ts");
const { createRun, enqueue } = await import("../lib/queue.ts");
const { listEntities, entityDetail } = await import("../lib/queries.ts");

const CONFIG = path.join(DATA_DIR, "config.json");

/* ------------------------------------------------------- the config store */

section("Config writes that cannot lose the keys");
{
  writeStore({ keys: [{ id: "a", key: "secret-1" }], pace: 4 });
  check("a write comes back intact", readStore().keys?.[0]?.key === "secret-1");
  check("no temp file is left behind", !fs.readdirSync(DATA_DIR).some((f) => f.endsWith(".tmp")));

  // The disaster case: the file exists and does not parse — a process was
  // killed mid-write. The old code read {} here, and the next write persisted
  // that emptiness over every key.
  fs.writeFileSync(CONFIG, '{"keys":[{"id":"a","key":"secret-1"');
  const recovered = readStore();
  check("a torn file is not read as an empty config", recovered.keys === undefined);
  const backups = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith("config.json.corrupt-"));
  check("it is quarantined, not shadowed", backups.length === 1, fs.readdirSync(DATA_DIR).join(","));
  check(
    "the secrets survive inside the quarantined copy",
    fs.readFileSync(path.join(DATA_DIR, backups[0]), "utf8").includes("secret-1")
  );

  writeStore({ keys: [{ id: "b", key: "secret-2" }] });
  check("writing after a quarantine works normally", readStore().keys?.[0]?.key === "secret-2");

  // The other half of the same disaster: the file exists but cannot be read
  // right now — EBUSY under a rename, EPERM under a scanner. That used to be
  // treated as first run, and the next write persisted an empty ring. A
  // directory where the file should be is the portable way to get a read
  // error that is not ENOENT.
  fs.rmSync(CONFIG, { force: true });
  fs.mkdirSync(CONFIG);
  let threw = false;
  try {
    readStore();
  } catch {
    threw = true;
  }
  check("a read error that is not 'no such file' is thrown, not read as empty", threw);
  fs.rmdirSync(CONFIG);
  check("with the file genuinely absent, empty is the truth", readStore().keys === undefined);
  writeStore({ keys: [{ id: "c", key: "secret-3" }] });
}

/* -------------------------------------------------------- request hygiene */

section("Ids and bodies that do not lie");
{
  check("a real id passes", asId("41") === 41);
  check("junk is refused, not NaN", asId("abc") === null);
  check("zero is not a row", asId("0") === null);
  check("negatives are not rows", asId("-3") === null);
  check("fractions are not rows", asId("3.5") === null);
  check("empty is refused", asId("") === null);

  const bad = await readBody(new Request("http://x/", { method: "POST", body: "{oops" }));
  check("a malformed body reads as null, not a throw", bad === null);
  const good = await readBody(
    new Request("http://x/", {
      method: "POST",
      body: '{"a":1}',
      headers: { "content-type": "application/json" },
    })
  );
  check("a well-formed body reads through", good?.a === 1);
}

/* ------------------------------------------------- the split keeps order */

section("Splitting a chunk keeps the book in order");
{
  const src = Number(
    db().prepare("INSERT INTO sources (title, kind, status) VALUES ('Book','text','ready')").run()
      .lastInsertRowid
  );
  const mk = (seq, text) =>
    Number(
      db()
        .prepare(
          "INSERT INTO chunks (source_id, seq, text, token_est, locator_json) VALUES (?,?,?,10,'{}')"
        )
        .run(src, seq, text).lastInsertRowid
    );
  mk(0, "The chunk before.");
  const fatHalfA = "First half sentence. ".repeat(80);
  const fatHalfB = "Second half sentence. ".repeat(80);
  const fat = mk(1, `${fatHalfA}\n\n${fatHalfB}`);
  mk(2, "The chunk after.");

  const runId = createRun({ kind: "ingest", label: "split test" });
  enqueue(runId, [{ kind: "extract", payload: { chunkId: fat } }]);
  const task = db()
    .prepare("SELECT * FROM tasks WHERE run_id=? AND kind='extract'")
    .get(runId);

  await splitTask(task);

  const after = db()
    .prepare("SELECT id, seq, substr(text,1,12) AS head FROM chunks WHERE source_id=? ORDER BY seq, id")
    .all(src);
  check("the original is gone", !after.some((c) => c.id === fat));
  check("four chunks remain", after.length === 4, JSON.stringify(after));
  check(
    "seqs are strictly increasing — no ties for ORDER BY to break arbitrarily",
    after.every((c, i) => i === 0 || c.seq > after[i - 1].seq),
    JSON.stringify(after.map((c) => c.seq))
  );
  check("the first half precedes the second", after[1].head.startsWith("First"));
  check("the trailing chunk stepped aside", after[3].head.startsWith("The chunk af"));

  const t = db().prepare("SELECT state FROM tasks WHERE id=?").get(task.id);
  check("the split task is superseded in the same breath", t.state === "superseded");
  const halves = db()
    .prepare("SELECT id, seq, order_hint, payload_json FROM tasks WHERE run_id=? AND state='pending' ORDER BY order_hint")
    .all(runId);
  check("both halves are queued", halves.length === 2);
  check(
    "the halves take distinct places in the queue, first before second",
    halves.length === 2 && halves[0].order_hint < halves[1].order_hint && halves[0].order_hint > task.seq,
    JSON.stringify(halves.map((h) => h.order_hint))
  );
  const firstHalfChunk = JSON.parse(halves[0]?.payload_json ?? "{}").chunkId;
  check(
    "and the first place holds the first half",
    after.find((c) => c.id === firstHalfChunk)?.head.startsWith("First")
  );
  const halfIds = halves.map((h) => JSON.parse(h.payload_json).chunkId);
  check(
    "the new chunks are stamped queued, so read-along does not queue them again",
    halfIds.length === 2 &&
      halfIds.every((id) => db().prepare("SELECT queued_at FROM chunks WHERE id=?").get(id)?.queued_at)
  );
  const claimed = [];
  const { claimNext } = await import("../lib/queue.ts");
  for (let i = 0; i < 2; i++) claimed.push(JSON.parse(claimNext().payload_json).chunkId);
  check("claimNext hands them out in that order", claimed[0] === firstHalfChunk, JSON.stringify(claimed));
}

section("Only a first reading can be split");
{
  const { failTask } = await import("../lib/queue.ts");
  void failTask;
  const src = Number(
    db().prepare("INSERT INTO sources (title, kind, status) VALUES ('Book 2','text','ready')").run()
      .lastInsertRowid
  );
  const text = `${"A sentence. ".repeat(120)}\n\n${"Another. ".repeat(120)}`;
  const mkFat = () =>
    Number(
      db()
        .prepare("INSERT INTO chunks (source_id, seq, text, token_est, locator_json) VALUES (?,0,?,10,'{}')")
        .run(src, text).lastInsertRowid
    );

  // An Enhance task runs over a passage that already has quotes on it.
  // Splitting that deleted the quotes, the read marks and the bookmarks with
  // the chunk, and re-queued the halves over nothing.
  const enhanced = mkFat();
  const ent = Number(
    db()
      .prepare("INSERT INTO entities (type, canonical_name, normalized, entry_state) VALUES ('person','Z','z','fresh')")
      .run().lastInsertRowid
  );
  const mentionId = Number(
    db()
      .prepare("INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote) VALUES (?,?,?,'Z','q')")
      .run(ent, enhanced, src).lastInsertRowid
  );
  const runId = createRun({ kind: "enhance", label: "enhance split test" });
  enqueue(runId, [{ kind: "enhance", payload: { chunkId: enhanced } }]);
  const enhanceTask = db().prepare("SELECT * FROM tasks WHERE run_id=?").get(runId);
  await splitTask(enhanceTask);
  const afterEnhance = db().prepare("SELECT state, last_error FROM tasks WHERE id=?").get(enhanceTask.id);
  check("an enhance task is failed, not split", afterEnhance.state === "failed", afterEnhance.state);
  check("and says why", /first reading/i.test(afterEnhance.last_error ?? ""), afterEnhance.last_error);
  check("the chunk survives", db().prepare("SELECT COUNT(*) n FROM chunks WHERE id=?").get(enhanced).n === 1);
  check("and so does its evidence", db().prepare("SELECT COUNT(*) n FROM mentions WHERE id=?").get(mentionId).n === 1);

  // Even an extract task must not discard a passage that has grown dependants.
  const run2 = createRun({ kind: "ingest", label: "extract over evidence" });
  enqueue(run2, [{ kind: "extract", payload: { chunkId: enhanced } }]);
  const extractTask = db().prepare("SELECT * FROM tasks WHERE run_id=?").get(run2);
  await splitTask(extractTask);
  check(
    "an extract task over a passage with quotes refuses too",
    db().prepare("SELECT state FROM tasks WHERE id=?").get(extractTask.id).state === "failed"
  );
  check("the evidence is still there", db().prepare("SELECT COUNT(*) n FROM mentions WHERE id=?").get(mentionId).n === 1);

  // A bookmark alone is enough.
  const marked = mkFat();
  db().prepare("INSERT INTO bookmarks (source_id, chunk_id) VALUES (?,?)").run(src, marked);
  const run3 = createRun({ kind: "ingest", label: "extract over bookmark" });
  enqueue(run3, [{ kind: "extract", payload: { chunkId: marked } }]);
  await splitTask(db().prepare("SELECT * FROM tasks WHERE run_id=?").get(run3));
  check("a bookmarked passage is never split", db().prepare("SELECT COUNT(*) n FROM chunks WHERE id=?").get(marked).n === 1);
}

section("A retry does not hold the queue");
{
  const q = await import("../lib/queue.ts");
  const runId = q.createRun({ kind: "ingest", label: "defer test" });
  q.enqueue(runId, [
    { kind: "extract", payload: { n: 1 } },
    { kind: "extract", payload: { n: 2 } },
  ]);
  const first = q.claimNext();
  // Back in the queue, but not for a minute.
  q.deferTask(first.id, new Date(Date.now() + 60_000), "Rate limited; waiting.");
  const next = q.claimNext();
  check("the deferred task is passed over", next && next.id !== first.id, String(next?.id));
  check("in favour of the one behind it", JSON.parse(next.payload_json).n === 2);
  check("nothing else is claimable while it waits", q.claimNext() === undefined);
  check("the queue knows a task is waiting", q.hasDeferredTasks());
  const due = q.nextDueAt();
  check(
    "and when it is due, so the wake timer can be set for it",
    due && due.getTime() > Date.now() + 50_000 && due.getTime() <= Date.now() + 60_000,
    due?.toISOString()
  );
  q.deferTask(first.id, new Date(Date.now() - 1000), "Rate limited; waiting.");
  check("once its time has passed it is claimable again", q.claimNext()?.id === first.id);
  db().prepare("UPDATE tasks SET state='done' WHERE run_id=?").run(runId);
  check("and the queue no longer reports a wait", !q.hasDeferredTasks());
}

section("A failure while handling a failure does not kill the loop");
{
  const q = await import("../lib/queue.ts");
  const { startWorker } = await import("../lib/worker.ts");
  const { TruncatedOutputError } = await import("../lib/ai/errors.ts");
  process.env.CORPUS_WORKER_IDLE_MS = "150";

  const runId = q.createRun({ kind: "ingest", label: "disposition test" });
  q.enqueue(runId, [
    { kind: "extract", payload: { chunkId: 1 } },
    { kind: "extract", payload: { after: true } },
  ]);
  // The first task's payload is made unreadable, so the split that a
  // truncation asks for throws inside the catch block.
  const [broken, after] = db()
    .prepare("SELECT id, payload_json FROM tasks WHERE run_id=? ORDER BY seq")
    .all(runId);
  db().prepare("UPDATE tasks SET payload_json='{not json' WHERE id=?").run(broken.id);

  let ranAfter = false;
  await startWorker({
    async extract(task) {
      if (task.id === broken.id) throw new TruncatedOutputError();
      ranAfter = true;
      q.finishTask(task.id, task.run_id, { tokensIn: 1, tokensOut: 1 });
    },
  });

  const b = db().prepare("SELECT state, last_error FROM tasks WHERE id=?").get(broken.id);
  check("the task whose handling blew up is failed, not stranded", b.state === "failed", b.state);
  check("with both errors on it", /handling that/.test(b.last_error ?? ""), b.last_error);
  check("and the loop went on to the next task", ranAfter);
  check("the run settled", q.getRun(runId).state === "failed", q.getRun(runId).state);
  void after;
}

section("A failed model task is retried on its own, a few times, after a rest");
// "Network kept failing" is a verdict on an afternoon, not on a passage. An
// entry that failed to write used to stay failed until someone pressed Retry.
{
  const q = await import("../lib/queue.ts");
  const runId = q.createRun({ kind: "entry", label: "auto-retry test" });
  q.enqueue(runId, [
    { kind: "entry", payload: { entityId: 1 } },
    { kind: "fetch_item", payload: { itemId: 1 } },
  ]);
  const ids = db().prepare("SELECT id, kind FROM tasks WHERE run_id=? ORDER BY id").all(runId);
  const entryId = ids.find((t) => t.kind === "entry").id;
  const fetchId = ids.find((t) => t.kind === "fetch_item").id;

  // Both fail. Only the model task is retriable; the fetch is not a model's moment.
  db().prepare("UPDATE tasks SET state='failed', last_error='Network kept failing.' WHERE run_id=?").run(runId);
  db().prepare("UPDATE runs SET state='failed' WHERE id=?").run(runId);
  check("a fresh failure is left to rest", q.retryFailedAutomatically() === 0);
  check("but the worker knows one is owed", q.hasRetryableFailures());

  const age = (id, minutes) =>
    db().prepare("UPDATE tasks SET updated_at=datetime('now', ?) WHERE id=?").run(`-${minutes} minutes`, id);
  age(entryId, 40);
  age(fetchId, 40);
  check("after half an hour the model task goes back", q.retryFailedAutomatically() === 1);
  const entry = db().prepare("SELECT state, retries, attempts, last_error FROM tasks WHERE id=?").get(entryId);
  check("it is pending again with its attempts reset", entry.state === "pending" && entry.attempts === 0);
  check("and the retry is counted on the row", entry.retries === 1);
  check("the reason is kept, marked as a retry", /Retried on its own after: Network kept failing/.test(entry.last_error));
  check("the fetch stays failed", db().prepare("SELECT state FROM tasks WHERE id=?").get(fetchId).state === "failed");
  check("the run is queued again", q.getRun(runId).state === "queued");

  // Three strikes and it stays failed for a person to look at.
  for (let i = 0; i < 2; i++) {
    db().prepare("UPDATE tasks SET state='failed' WHERE id=?").run(entryId);
    age(entryId, 40);
    q.retryFailedAutomatically();
  }
  db().prepare("UPDATE tasks SET state='failed' WHERE id=?").run(entryId);
  age(entryId, 40);
  check("the limit is three", db().prepare("SELECT retries FROM tasks WHERE id=?").get(entryId).retries === 3);
  check("a fourth failure is not retried", q.retryFailedAutomatically() === 0);
  check(
    "and this run owes nothing more",
    db().prepare("SELECT COUNT(*) AS n FROM tasks WHERE run_id=? AND kind='entry' AND state='failed' AND retries < 3").get(runId).n === 0
  );
  check("a person's Retry still works", q.retryFailedTasks(runId) === 2);
}

section("Runs you paused stay paused");
{
  const q = await import("../lib/queue.ts");
  const runId = q.createRun({ kind: "ingest", label: "paused_user test" });
  q.enqueue(runId, [{ kind: "extract", payload: { n: 1 } }]);
  q.pauseRun(runId, "paused_user", "Paused by you.");

  check("resume without force leaves it alone", q.resumeRun(runId) === false);
  check("and the state is untouched", q.getRun(runId).state === "paused_user");

  db().prepare("UPDATE tasks SET state='failed' WHERE run_id=?").run(runId);
  check("retrying failed tasks re-queues them", q.retryFailedTasks(runId) === 1);
  check("but does not un-pause the run", q.getRun(runId).state === "paused_user", q.getRun(runId).state);
  check("the task is pending, ready for when you resume", q.getRun(runId).pending === 1);

  db().prepare("UPDATE tasks SET state='done' WHERE run_id=?").run(runId);
  q.settleRun(runId);
  check("settling never overwrites your pause", q.getRun(runId).state === "paused_user", q.getRun(runId).state);

  check("force is the Resume button", q.resumeRun(runId, { force: true }) === true);
  check("and it works", q.getRun(runId).state === "queued");

  q.pauseRun(runId, "paused_quota", "Out of quota.");
  check("an app-imposed pause needs no force", q.resumeRun(runId) === true);

  check("getRun by id finds a run beyond the first thousand-row window", q.getRun(runId)?.id === runId);
  check("and nothing for a run that does not exist", q.getRun(999999) === undefined);
}

/* -------------------------------------------- recovery respects the living */

section("Crash recovery only fires when no one else is alive");
{
  const runId = createRun({ kind: "ingest", label: "recovery test" });
  enqueue(runId, [{ kind: "extract", payload: { chunkId: 999 } }]);
  db().prepare("UPDATE tasks SET state='running' WHERE run_id=?").run(runId);

  // A real second process, alive for the duration of the check.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
  fs.writeFileSync(path.join(DATA_DIR, "corpus.pid"), String(child.pid), "utf8");

  const reopen = () => {
    globalThis.__corpusDb?.close();
    globalThis.__corpusDb = undefined;
    return db();
  };

  reopen();
  const held = db().prepare("SELECT state FROM tasks WHERE run_id=?").get(runId);
  check(
    "a live sibling's in-flight task is left alone",
    held.state === "running",
    held.state
  );

  child.kill();
  await new Promise((r) => setTimeout(r, 300));

  reopen();
  const freed = db().prepare("SELECT state FROM tasks WHERE run_id=?").get(runId);
  check("once it is dead, the task is recovered", freed.state === "pending", freed.state);

  check(
    "our own pid never counts as a sibling",
    (() => {
      fs.writeFileSync(path.join(DATA_DIR, "corpus.pid"), String(process.pid), "utf8");
      db().prepare("UPDATE tasks SET state='running' WHERE run_id=?").run(runId);
      reopen();
      return db().prepare("SELECT state FROM tasks WHERE run_id=?").get(runId).state === "pending";
    })()
  );
}

/* ------------------------------------------------ reads that stay honest */

section("The discard ledger reaches every reader");
{
  // Structural: these are the four call sites the audit caught reading raw
  // `mentions` after everything else had moved. A regression here silently
  // hands rejected evidence back to the model or the export file.
  const retrievalSrc = fs.readFileSync(path.join(root, "lib", "retrieval.ts"), "utf8");
  check("retrieval joins live_mentions", retrievalSrc.includes("JOIN live_mentions m ON m.chunk_id"));
  const searchSrc = fs.readFileSync(
    path.join(root, "app", "api", "drafts", "search", "route.ts"),
    "utf8"
  );
  check("the writing desk's search does too", searchSrc.includes("JOIN live_mentions"));
  const exportSrc = fs.readFileSync(path.join(root, "app", "api", "export", "route.ts"), "utf8");
  check(
    "and both exports",
    !/FROM mentions\b/.test(exportSrc) && !/FROM mentions"/.test(exportSrc)
  );
}

section("Verify flags reach the entry page");
{
  const ent = Number(
    db()
      .prepare(
        "INSERT INTO entities (type, canonical_name, normalized, entry_state) VALUES ('person','X','x','fresh')"
      )
      .run().lastInsertRowid
  );
  db()
    .prepare("INSERT INTO entries (entity_id, summary, body_md, built_from_hash) VALUES (?,'','Body.','h')")
    .run(ent);
  db()
    .prepare(
      "INSERT INTO entry_flags (entity_id, sentence, verdict, note, mention_ids) VALUES (?,?,?,?,?)"
    )
    .run(ent, "He did the thing [[m:9]].", "unsupported", "The passage says otherwise.", "9");

  const detail = entityDetail(ent);
  check("entityDetail carries the flags", detail.flags.length === 1);
  check("with the verdict", detail.flags[0].verdict === "unsupported");
  check("and the note", detail.flags[0].note.includes("otherwise"));
}

section("Regenerating investigates the verification verdicts");
{
  const { pastFailures } = await import("../lib/pipeline/entry.ts");

  const ent = Number(
    db()
      .prepare(
        "INSERT INTO entities (type, canonical_name, normalized, entry_state) VALUES ('person','Y','y','fresh')"
      )
      .run().lastInsertRowid
  );

  check("an unflagged entity adds nothing to the prompt", pastFailures(ent) === "");

  db()
    .prepare(
      "INSERT INTO entry_flags (entity_id, sentence, verdict, note, mention_ids) VALUES (?,?,?,?,?)"
    )
    .run(
      ent,
      "Sharon assumed leadership of Likud following Barak's missteps [[m:41]].",
      "overstated",
      "The passage says he already led Likud and merely benefited.",
      "41"
    );
  db()
    .prepare(
      "INSERT INTO entry_flags (entity_id, sentence, verdict, note, mention_ids) VALUES (?,?,?,?,?)"
    )
    .run(ent, "He was involved in student politics in Cairo [[m:42]].", "unsupported", null, "42");

  const block = pastFailures(ent);
  check("the block announces itself", block.startsWith("FAILED VERIFICATION"));
  check("each verdict is named", block.includes("[overstated]") && block.includes("[unsupported]"));
  check(
    "the verifier's note rides along",
    block.includes("already led Likud and merely benefited")
  );
  check(
    "the markers stay in the sentence — they name the misattached citations",
    block.includes("[[m:41]]")
  );
  check("a flag without a note still lists cleanly", block.includes("student politics in Cairo"));
  check(
    "the instruction is to investigate, not to obey",
    block.includes("If the evidence genuinely supports the claim, keep it")
  );
  check(
    "and outside truth is named as the enemy",
    block.includes("however true you") || block.includes("outside these sources")
  );

  // A pathological entity with dozens of flags must not drown the prompt.
  for (let i = 0; i < 30; i++) {
    db()
      .prepare(
        "INSERT INTO entry_flags (entity_id, sentence, verdict, note, mention_ids) VALUES (?,?,?,?,?)"
      )
      .run(ent, `Filler claim number ${i} [[m:${100 + i}]].`, "unsupported", null, String(100 + i));
  }
  const capped = pastFailures(ent);
  const shown = (capped.match(/^- \[/gm) ?? []).length;
  check("the list is capped", shown <= 15, `${shown} shown`);
  check("and the cap is said out loud", /and \d+ more like these/.test(capped));
}

section("Read again re-reads only what has been read");
{
  const { reextractSource } = await import("../lib/reextract.ts");

  const src = Number(
    db()
      .prepare("INSERT INTO sources (title, kind, status) VALUES ('Partial','text','ready')")
      .run().lastInsertRowid
  );
  const mkChunk = (seq) =>
    Number(
      db()
        .prepare(
          "INSERT INTO chunks (source_id, seq, text, token_est, locator_json, extracted_at, queued_at) VALUES (?,?,?,10,'{}',datetime('now'),datetime('now'))"
        )
        .run(src, seq, `Passage ${seq}.`).lastInsertRowid
    );
  const mkEntity = (name) =>
    Number(
      db()
        .prepare(
          "INSERT INTO entities (type, canonical_name, normalized, entry_state) VALUES ('person',?,?,'fresh')"
        )
        .run(name, name.toLowerCase()).lastInsertRowid
    );
  const mkMention = (ent, chunk) =>
    Number(
      db()
        .prepare(
          "INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote) VALUES (?,?,?,'X','A quote.')"
        )
        .run(ent, chunk, src).lastInsertRowid
    );

  const [c0, c1, c2, c3] = [mkChunk(0), mkChunk(1), mkChunk(2), mkChunk(3)];
  // onlyEarly lives only in the read part; everywhere spans both.
  const onlyEarly = mkEntity("OnlyEarly");
  const everywhere = mkEntity("Everywhere");
  mkMention(onlyEarly, c0);
  const mEarly = mkMention(everywhere, c1);
  const mLate = mkMention(everywhere, c3);
  db()
    .prepare(
      "INSERT INTO relations (from_entity, to_entity, type, source_id, mention_id) VALUES (?,?,'knew',?,?)"
    )
    .run(onlyEarly, everywhere, src, mEarly);

  // The first two passages have been read; the last two have not.
  for (const c of [c0, c1])
    db()
      .prepare("INSERT INTO read_passages (source_id, chunk_id, how) VALUES (?,?,'read')")
      .run(src, c);

  const r = reextractSource(src);
  check("the scope is the read part", r.scope === "read");
  check("two passages, not four", r.chunks === 2 && r.totalChunks === 4, JSON.stringify(r));

  check(
    "quotes from read passages are withdrawn",
    db().prepare("SELECT COUNT(*) n FROM mentions WHERE chunk_id IN (?,?)").get(c0, c1).n === 0
  );
  check(
    "quotes from unread passages survive",
    db().prepare("SELECT COUNT(*) n FROM mentions WHERE id=?").get(mLate).n === 1
  );
  check(
    "an entity evidenced only in the read part is removed",
    db().prepare("SELECT COUNT(*) n FROM entities WHERE id=?").get(onlyEarly).n === 0
  );
  const surv = db().prepare("SELECT entry_state FROM entities WHERE id=?").get(everywhere);
  check("one still standing elsewhere is marked stale", surv.entry_state === "stale", surv.entry_state);
  check(
    "the relation tied to a withdrawn quote goes with it",
    db().prepare("SELECT COUNT(*) n FROM relations WHERE from_entity=?").get(onlyEarly).n === 0
  );

  const chunks = db()
    .prepare("SELECT id, extracted_at, queued_at FROM chunks WHERE source_id=? ORDER BY seq")
    .all(src);
  check(
    "read passages are open for re-reading",
    chunks.slice(0, 2).every((c) => c.extracted_at === null)
  );
  check(
    "and stamped queued so read-along does not queue them twice",
    chunks.slice(0, 2).every((c) => c.queued_at !== null)
  );
  check(
    "unread passages are untouched",
    chunks.slice(2).every((c) => c.extracted_at !== null)
  );

  const queued = db()
    .prepare("SELECT payload_json FROM tasks WHERE run_id=? AND kind='extract'")
    .all(r.runId)
    .map((t) => JSON.parse(t.payload_json).chunkId);
  check("extraction is queued for exactly the read passages", queued.length === 2 && queued.includes(c0) && queued.includes(c1), JSON.stringify(queued));
  check(
    "the source stays ready — the book is still readable",
    db().prepare("SELECT status FROM sources WHERE id=?").get(src).status === "ready"
  );
  const tail = db()
    .prepare("SELECT DISTINCT kind FROM tasks WHERE run_id=? AND kind != 'extract'")
    .all(r.runId)
    .map((t) => t.kind);
  check(
    "the full tail runs: resolve, sweep, context, entries",
    ["resolve", "sweep", "plan_context", "plan_entries"].every((k) => tail.includes(k)),
    JSON.stringify(tail)
  );
}

section("With nothing read, Read again means the whole source");
{
  const { reextractSource } = await import("../lib/reextract.ts");
  const src = Number(
    db()
      .prepare("INSERT INTO sources (title, kind, status) VALUES ('Untouched','text','ready')")
      .run().lastInsertRowid
  );
  for (let i = 0; i < 3; i++)
    db()
      .prepare(
        "INSERT INTO chunks (source_id, seq, text, token_est, locator_json, extracted_at) VALUES (?,?,?,10,'{}',datetime('now'))"
      )
      .run(src, i, `Passage ${i}.`);

  const r = reextractSource(src);
  check("the scope is everything", r.scope === "all" && r.chunks === 3, JSON.stringify(r));
  check(
    "and the source goes back to extracting",
    db().prepare("SELECT status FROM sources WHERE id=?").get(src).status === "extracting"
  );

  const missing = reextractSource(999999);
  check("a missing source is an error, not a crash", "error" in missing);
}

section("The morning routine");
{
  const { nextMorningAt, choresDue, flaggedForRewrite, queueMorningRun, MIN_FLAGS_FOR_REWRITE } =
    await import("../lib/chores.ts");

  // The clock arithmetic.
  const beforeHour = new Date(2026, 7, 16, 5, 30);
  const afterHour = new Date(2026, 7, 16, 9, 0);
  check(
    "before the hour, this morning is next",
    nextMorningAt(beforeHour, 7).getTime() === new Date(2026, 7, 16, 7, 0).getTime()
  );
  check(
    "after the hour, tomorrow is next",
    nextMorningAt(afterHour, 7).getTime() === new Date(2026, 7, 17, 7, 0).getTime()
  );
  check("two flags is the line", MIN_FLAGS_FOR_REWRITE === 2);

  check(
    "a scratch library never runs chores",
    choresDue(new Date(2026, 7, 16, 9, 0)) === false,
    "this test process runs under CORPUS_DATA_DIR, which is exactly the point"
  );

  // Who gets rewritten: two flags in, one flag out, no-entry out.
  const mkEntity = (name) =>
    Number(
      db()
        .prepare(
          "INSERT INTO entities (type, canonical_name, normalized, entry_state) VALUES ('person',?,?,'fresh')"
        )
        .run(name, name.toLowerCase()).lastInsertRowid
    );
  const flag = (ent, n) => {
    for (let i = 0; i < n; i++)
      db()
        .prepare(
          "INSERT INTO entry_flags (entity_id, sentence, verdict, mention_ids) VALUES (?,?,'unsupported','1')"
        )
        .run(ent, `Claim ${i}.`);
  };
  const entry = (ent) =>
    db()
      .prepare(
        "INSERT INTO entries (entity_id, summary, body_md, built_from_hash) VALUES (?,'','Body.','h')"
      )
      .run(ent);

  const twice = mkEntity("TwiceFlagged");
  entry(twice);
  flag(twice, 2);
  const once = mkEntity("OnceFlagged");
  entry(once);
  flag(once, 1);
  const noEntry = mkEntity("FlaggedNoEntry");
  flag(noEntry, 3);

  const due = flaggedForRewrite();
  check(
    "two or more flags qualifies",
    due.some((f) => f.entityId === twice)
  );
  check(
    "a single flag does not — one can be the verifier being fussy",
    !due.some((f) => f.entityId === once)
  );
  check(
    "no entry, nothing to rewrite",
    !due.some((f) => f.entityId === noEntry)
  );

  // What the run queues.
  const q = queueMorningRun();
  check("it reports the rewrites", q.rewrites >= 1);
  const tasks = db()
    .prepare("SELECT kind, payload_json FROM tasks WHERE run_id=? ORDER BY seq")
    .all(q.runId);
  const entryTasks = tasks.filter((t) => t.kind === "entry").map((t) => JSON.parse(t.payload_json));
  check(
    "each flagged entry is queued as a forced rewrite",
    entryTasks.some((p) => p.entityId === twice && p.force === true),
    JSON.stringify(entryTasks)
  );
  check(
    "the once-flagged entry is left alone",
    !entryTasks.some((p) => p.entityId === once)
  );
  check(
    "and the picture hunt rides along",
    tasks.some((t) => t.kind === "plan_portraits")
  );
  check(
    "pictures run even on a morning with nothing flagged",
    (() => {
      db().prepare("DELETE FROM entry_flags").run();
      const empty = queueMorningRun();
      const kinds = db()
        .prepare("SELECT DISTINCT kind FROM tasks WHERE run_id=?")
        .all(empty.runId)
        .map((t) => t.kind);
      return empty.rewrites === 0 && kinds.includes("plan_portraits") && !kinds.includes("entry");
    })()
  );
}

section("The pedia list is bounded but not silently");
{
  check("a limit is respected", listEntities({ limit: 1 }).length <= 1);
  check("a big limit is allowed through", Array.isArray(listEntities({ limit: 100000 })));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
