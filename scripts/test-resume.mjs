/**
 * Verifies the machinery this whole app rests on: that a run survives being
 * killed, and that it can tell "you sent too many requests this minute" apart
 * from "your key is spent for the day".
 *
 * Runs against a scratch database. No API key needed.
 *
 *   node scripts/test-resume.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

// Never touch the real library.
const SANDBOX = path.join(root, "data", "__test__");
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

// ---------------------------------------------------------------------------
section("Telling a rate limit apart from an exhausted key");
// ---------------------------------------------------------------------------
const { classify, TruncatedOutputError, SafetyBlockError } = await import("../lib/ai/errors.ts");

const perMinute = new Error(
  `429 Too Many Requests ${JSON.stringify({
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }],
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "41s" },
      ],
    },
  })}`
);
const dMin = classify(perMinute, 1);
check("per-minute 429 retries rather than parking the run", dMin.kind === "retry", dMin.kind);
check("it waits exactly the delay Google asked for (41s)", dMin.delayMs === 41000, String(dMin.delayMs));

const perDay = new Error(
  `429 ${JSON.stringify({
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }],
        },
      ],
    },
  })}`
);
const dDay = classify(perDay, 1);
check("per-day 429 parks the run instead of hammering a dead key", dDay.kind === "pause_quota", dDay.kind);
check("it sets a future resume time", dDay.kind === "pause_quota" && dDay.resumeAt > new Date());

check(
  "it comes back within the hour rather than waiting for tomorrow",
  dDay.kind === "pause_quota" && dDay.resumeAt.getTime() <= Date.now() + 61 * 60_000,
  dDay.kind === "pause_quota" ? dDay.resumeAt.toLocaleString() : dDay.kind
);

check("401 parks for the key, not the quota", classify(new Error("401 API key not valid"), 1).kind === "pause_key");
check("503 backs off and retries", classify(new Error("503 Service Unavailable"), 1).kind === "retry");
check("a 503 that never clears fails only its own task", classify(new Error("503 Service Unavailable"), 9).kind === "fail");
check("a truncated response asks to split the input", classify(new TruncatedOutputError(), 1).kind === "split");
check("a safety block skips that passage and moves on", classify(new SafetyBlockError("SAFETY"), 1).kind === "skip");

// ---------------------------------------------------------------------------
section("Surviving a kill mid-run");
// ---------------------------------------------------------------------------
const dbmod = await import("../lib/db/index.ts");
const queue = await import("../lib/queue.ts");
const { startWorker, stopWorker } = await import("../lib/worker.ts");

const sourceId = Number(
  dbmod
    .db()
    .prepare("INSERT INTO sources (title, kind, status) VALUES ('Test source','text','new')")
    .run().lastInsertRowid
);

const runId = queue.createRun({ sourceId, kind: "ingest", label: "Test run" });
queue.enqueue(
  runId,
  Array.from({ length: 6 }, (_, i) => ({ kind: "extract", payload: { n: i } }))
);

const completed = [];
let quotaThrown = false;

const flaky = {
  async extract(task) {
    const { n } = JSON.parse(task.payload_json);
    if (n === 3 && !quotaThrown) {
      quotaThrown = true;
      throw perDay;
    }
    completed.push(n);
    queue.finishTask(task.id, task.run_id, { tokensIn: 100, tokensOut: 50 });
  },
};

await startWorker(flaky);

let run = queue.getRun(runId);
check("run parked itself rather than burning through the rest", run.state === "paused_quota", run.state);
check("it stopped where it failed, having finished the first three", completed.length === 3, JSON.stringify(completed));
check("the interrupted task went back to the queue, not lost", run.pending === 3, `pending=${run.pending}`);
check("tokens spent so far were billed to the run", run.tokens_in === 300 && run.tokens_out === 150);

// Now simulate the process being killed with a task in flight.
dbmod.db().prepare("UPDATE tasks SET state='running' WHERE state='pending' AND run_id=?").run(runId);
const orphaned = dbmod.db().prepare("SELECT COUNT(*) AS n FROM tasks WHERE state='running'").get().n;
check("a task is left mid-flight, exactly as a crash would leave it", orphaned > 0, String(orphaned));

// Reopen the database the way a restarted server does.
dbmod.db().close();
globalThis.__corpusDb = undefined;
const dbmod2 = await import("../lib/db/index.ts?restart");
const stuck = dbmod2.db().prepare("SELECT COUNT(*) AS n FROM tasks WHERE state='running'").get().n;
check("on restart, interrupted tasks are back in the queue", stuck === 0, `${stuck} still stuck`);

// ---------------------------------------------------------------------------
section("Resuming");
// ---------------------------------------------------------------------------
queue.resumeRun(runId);
await startWorker(flaky);

run = queue.getRun(runId);
check("the run finished once resumed", run.state === "done", run.state);
check(
  "all six steps ran exactly once — none repeated, none skipped",
  completed.length === 6 && new Set(completed).size === 6,
  JSON.stringify(completed)
);
check("the token ledger covers all six", run.tokens_in === 600, String(run.tokens_in));

// ---------------------------------------------------------------------------
section("A parked run comes back on its own");
// ---------------------------------------------------------------------------
// The bug this covers: wakeDueRuns only ever ran inside the worker loop, and
// the loop exits when idle. So nothing was left watching the clock, and a run
// parked overnight was still parked in the morning.
const { scheduleWake } = await import("../lib/worker.ts");

const parkedRun = queue.createRun({ sourceId, kind: "ingest", label: "Parked" });
queue.enqueue(parkedRun, [{ kind: "extract", payload: { n: 900 } }]);
// Park it as though its quota ran out, due a moment from now.
queue.pauseRun(parkedRun, "paused_quota", "Out of quota.", new Date(Date.now() + 400));

check("the run is parked and nothing is queued", queue.getRun(parkedRun).state === "paused_quota");
check("the queue reports when it is next due", queue.nextDueAt() !== undefined);
check("and knows a run is parked", queue.hasParkedRuns());

// This is what the worker does as it stands down.
let ran = false;
scheduleWake();
await new Promise((r) => setTimeout(r, 1200));
await startWorker({
  async extract(task) {
    ran = true;
    queue.finishTask(task.id, task.run_id, { tokensIn: 1, tokensOut: 1 });
  },
});

check(
  "once its time passed, the run was released without anyone asking",
  queue.getRun(parkedRun).state === "done",
  queue.getRun(parkedRun).state
);
check("and its work actually ran", ran);

// A key coming back early should not have to wait out a stale timer.
const earlyRun = queue.createRun({ sourceId, kind: "ingest", label: "Early" });
queue.enqueue(earlyRun, [{ kind: "extract", payload: { n: 901 } }]);
queue.pauseRun(earlyRun, "paused_quota", "Out of quota.", new Date(Date.now() + 60 * 60_000));
check("it is parked an hour out", queue.getRun(earlyRun).state === "paused_quota");

queue.wakeParkedRuns();
check(
  "but a key returning early releases it immediately",
  queue.getRun(earlyRun).state === "queued",
  queue.getRun(earlyRun).state
);

// ---------------------------------------------------------------------------
section("Stopping at a token budget");
// ---------------------------------------------------------------------------
const capRun = queue.createRun({ sourceId, kind: "ingest", label: "Capped", budgetCap: 300 });
queue.enqueue(
  capRun,
  Array.from({ length: 5 }, (_, i) => ({ kind: "extract", payload: { n: 100 + i } }))
);

await startWorker({
  async extract(task) {
    queue.finishTask(task.id, task.run_id, { tokensIn: 100, tokensOut: 50 });
  },
});

const capped = queue.getRun(capRun);
check("run parked when it reached its cap", capped.state === "paused_budget", capped.state);
check("it did not run far past the cap", capped.tokens_in + capped.tokens_out <= 450, String(capped.tokens_in + capped.tokens_out));
check("the unspent work is still queued, not discarded", capped.pending > 0, String(capped.pending));

// ---------------------------------------------------------------------------
section("Chunking, and matching names to the same person");
// ---------------------------------------------------------------------------
const { buildChunks } = await import("../lib/chunk.ts");
const page = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${"word ".repeat(200)}`).join("\n\n");
const chunks = buildChunks([{ text: page, label: "p. 1", locator: { page: 1 } }]);
check("a long page becomes several chunks", chunks.length > 1, String(chunks.length));
check(
  "no chunk blows past the window",
  chunks.every((c) => c.tokenEst <= 4200),
  `largest ${Math.max(...chunks.map((c) => c.tokenEst))}`
);
check("every chunk keeps the locator a citation needs", chunks.every((c) => c.locator.page === 1));

const { normalize, isSubsetName, trigramSimilarity } = await import("../lib/normalize.ts");
check(
  '"Dr. Gamal Abdel-Nasser" folds to a bare name',
  normalize("Dr. Gamal Abdel-Nasser") === "gamal abdel nasser",
  normalize("Dr. Gamal Abdel-Nasser")
);
check(
  "Arabic honorifics and alef forms fold together",
  normalize("الرئيس جمال عبد الناصر") === normalize("جمال عبد الناصر"),
  `"${normalize("الرئيس جمال عبد الناصر")}" vs "${normalize("جمال عبد الناصر")}"`
);
check(
  '"The Free Officers Movement" loses its article',
  normalize("The Free Officers Movement") === "free officers movement",
  normalize("The Free Officers Movement")
);
check("a surname is seen as part of a full name", isSubsetName("nasser", "gamal abdel nasser"));
check("two unrelated names score low", trigramSimilarity(normalize("Nasser"), normalize("Churchill")) < 0.3);

// ---------------------------------------------------------------------------
section("Entries going stale when new evidence lands");
// ---------------------------------------------------------------------------
const { hashOf } = await import("../lib/pipeline/entry.ts");
check("the same evidence hashes the same whatever the order", hashOf([3, 1, 2]) === hashOf([1, 2, 3]));
check("one more quote changes the hash — which is what marks an entry stale", hashOf([1, 2, 3]) !== hashOf([1, 2, 3, 4]));

// ---------------------------------------------------------------------------
section("What jumps the queue");
// ---------------------------------------------------------------------------
// The complaint this answers: a question typed into Ask sat behind five hundred
// re-extractions, which is twenty minutes of watching a spinner.
{
  const q = await import("../lib/queue.ts");

  const big = q.createRun({ kind: "reextract", label: "a long ingest" });
  q.enqueue(
    big,
    Array.from({ length: 20 }, (_, i) => ({ kind: "extract", payload: { chunk: i } }))
  );
  const decorate = q.createRun({ kind: "portraits", label: "pictures" });
  q.enqueue(decorate, [{ kind: "portrait", payload: { entityId: 1 } }]);
  // Queued last, and by far the newest run.
  const asked = q.createRun({ kind: "poll", label: "the feeds" });
  q.enqueue(asked, [{ kind: "poll", payload: { feedId: 1 } }]);

  const first = q.claimNext();
  check("a poll goes first, however long the queue ahead of it", first.kind === "poll", first?.kind);

  const second = q.claimNext();
  check("then the pipeline resumes in its own order", second.kind === "extract", second?.kind);
  check("and it is the oldest pending one", JSON.parse(second.payload_json).chunk === 0);

  // Drain the ingest; only then should the decoration run.
  const kinds = [];
  for (let i = 0; i < 20; i++) {
    const t = q.claimNext();
    if (!t) break;
    kinds.push(t.kind);
  }
  check("pictures wait for everything else", kinds[kinds.length - 1] === "portrait", kinds.join(","));
  check(
    "and nothing else was starved to get there",
    kinds.filter((k) => k === "extract").length === 19,
    `${kinds.filter((k) => k === "extract").length}`
  );
}

stopWorker();
dbmod2.db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
