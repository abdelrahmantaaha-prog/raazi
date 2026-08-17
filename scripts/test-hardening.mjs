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
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE run_id=? AND state='pending'")
    .get(runId);
  check("both halves are queued", halves.n === 2);
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
  const askSrc = fs.readFileSync(path.join(root, "lib", "pipeline", "ask.ts"), "utf8");
  check("Ask's retrieval joins live_mentions", askSrc.includes("JOIN live_mentions m ON m.chunk_id"));
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
