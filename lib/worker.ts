import { classify, explain } from "./ai/errors";
import { getConfig } from "./config";
import { queueStaleEntries, refreshInFlight } from "./entries";
import { nextMorningAt, runMorningChores } from "./chores";
import {
  claimNext,
  failTask,
  hasParkedRuns,
  nextDueAt,
  overBudget,
  pauseRun,
  releaseTask,
  settleRun,
  supersedeTask,
  wakeDueRuns,
} from "./queue";
import type { Task } from "./types";
import { claimWorkerPid, db } from "./db";

/** A handler does the work and reports what it spent. Handlers must write
 *  their own results and mark the task done inside a single transaction —
 *  see `commit` in lib/pipeline/handlers.ts. */
export type Handler = (task: Task) => Promise<void>;

declare global {
  // eslint-disable-next-line no-var
  var __corpusWorker:
    | { running: boolean; stop: boolean; idleSince: number; sweptAt?: number }
    | undefined;
}

const state = () => {
  if (!globalThis.__corpusWorker) {
    globalThis.__corpusWorker = { running: false, stop: false, idleSince: Date.now() };
  }
  return globalThis.__corpusWorker;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long the loop lingers on an empty queue before standing down. Any API
 *  route can start it again, so this only trades idle CPU against latency. */
const IDLE_MS = Number(process.env.CORPUS_WORKER_IDLE_MS ?? 30_000);

async function runOne(task: Task, handlers: Record<string, Handler>): Promise<void> {
  if (overBudget(task.run_id)) {
    releaseTask(task.id);
    pauseRun(
      task.run_id,
      "paused_budget",
      "Token budget for this run is spent. Raise the cap or resume to continue."
    );
    return;
  }

  const handler = handlers[task.kind];
  if (!handler) {
    failTask(task.id, `No handler registered for task kind "${task.kind}".`);
    return;
  }

  try {
    await handler(task);
  } catch (err) {
    const d = classify(err, task.attempts);
    const message = explain(d);
    console.warn(`[corpus] task ${task.id} (${task.kind}) → ${d.kind}: ${message}`);

    switch (d.kind) {
      case "retry":
        // Back into the queue; the sleep keeps us from spinning on it.
        releaseTask(task.id, message);
        await sleep(d.delayMs);
        break;

      case "pause_quota":
        releaseTask(task.id, message);
        pauseRun(task.run_id, "paused_quota", message, d.resumeAt);
        break;

      case "pause_key":
        releaseTask(task.id, message);
        pauseRun(task.run_id, "paused_key", message);
        break;

      case "skip":
        // The chunk is unusable, but the book is not. Keep going.
        db()
          .prepare(
            "UPDATE tasks SET state='skipped', last_error=?, updated_at=datetime('now') WHERE id=?"
          )
          .run(message, task.id);
        break;

      case "split":
        await splitTask(task);
        break;

      case "fail":
        failTask(task.id, message);
        break;
    }
  }

  settleRun(task.run_id);
}

/**
 * The model ran out of output room on this input. Halve the chunk and queue
 * the halves ahead of everything else, so a single dense page cannot stall a
 * book. Only chunk-shaped tasks can be split; anything else just fails.
 *
 * Exported for scripts/test-hardening.mjs, which asserts the seq bookkeeping —
 * the halves must slot into a strictly increasing order, not tie with each
 * other on the original's seq.
 */
export async function splitTask(task: Task) {
  const payload = JSON.parse(task.payload_json) as { chunkId?: number };
  if (!payload.chunkId) {
    failTask(task.id, "Output was truncated and this task cannot be split.");
    return;
  }

  const chunk = db()
    .prepare("SELECT * FROM chunks WHERE id=?")
    .get(payload.chunkId) as { id: number; text: string; source_id: number; doc_id: number | null; seq: number; locator_json: string } | undefined;

  if (!chunk || chunk.text.length < 2000) {
    failTask(task.id, "Output was truncated and the chunk is already minimal.");
    return;
  }

  // Split on a paragraph break near the middle so sentences survive intact.
  const mid = Math.floor(chunk.text.length / 2);
  const breakAt = chunk.text.indexOf("\n\n", mid);
  const cut = breakAt > 0 && breakAt < chunk.text.length - 500 ? breakAt : mid;

  const halves = [chunk.text.slice(0, cut).trim(), chunk.text.slice(cut).trim()];
  const locator = JSON.parse(chunk.locator_json) as Record<string, unknown>;

  db().transaction(() => {
    // Everything after the original steps aside by one, so the second half can
    // take seq+1 and the ordering stays strict. Both halves used to inherit the
    // original's seq — a tie that `ORDER BY seq` broke arbitrarily, so the
    // reader could show the second half first, and `precedingText` could hand
    // the extractor the wrong neighbour as back-reference context.
    db()
      .prepare("UPDATE chunks SET seq = seq + 1 WHERE source_id = ? AND seq > ?")
      .run(chunk.source_id, chunk.seq);

    const insert = db().prepare(
      `INSERT INTO chunks (source_id, doc_id, seq, text, token_est, locator_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const enqueueStmt = db().prepare(
      "INSERT INTO tasks (run_id, seq, kind, payload_json) VALUES (?, ?, ?, ?)"
    );
    halves.forEach((text, i) => {
      if (!text) return;
      const id = insert.run(
        chunk.source_id,
        chunk.doc_id,
        chunk.seq + i,
        text,
        Math.ceil(text.length / 4),
        JSON.stringify({ ...locator, split: i + 1 })
      ).lastInsertRowid;
      // The task seq matches the original's, keeping the halves next in line.
      enqueueStmt.run(task.run_id, task.seq, task.kind, JSON.stringify({ chunkId: Number(id) }));
    });
    // The oversized chunk is replaced by its halves.
    db().prepare("DELETE FROM chunks WHERE id=?").run(chunk.id);

    // Inside the transaction, deliberately. Superseding the task after the
    // commit left a window where a crash re-ran it against a chunk that no
    // longer exists, and a split that had actually succeeded was reported as a
    // failure.
    supersedeTask(task.id, "Output was truncated; split into two smaller chunks.");
  })();
}

/**
 * The loop. One at a time, on purpose: it keeps the rate limiter honest and
 * makes "where did it stop" answerable. Exits when the queue is empty for a
 * while, and any API route can start it again.
 */
export async function startWorker(override?: Record<string, Handler>): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = true;
  s.stop = false;

  const handlers = override ?? (await import("./pipeline/handlers")).handlers;

  // Mark this process as the one whose in-flight tasks are real, so a script
  // or second server opening the database does not "recover" them mid-call.
  claimWorkerPid();
  armMorningTimer();

  console.log("[corpus] worker started");
  try {
    while (!s.stop) {
      wakeDueRuns();
      const task = claimNext();

      if (!task) {
        // The queue is empty. Before standing down, catch any entries left out
        // of date by something other than an ingest — a merge you made by hand,
        // a source you removed, or a run that was interrupted before its
        // planning step. Without this they would wait for the next ingest.
        if (sweepStaleEntries()) continue;

        // The morning routine, if the machine slept past its hour or the
        // timer never got armed. Queues work, so loop back and claim it.
        if (runMorningChores()) continue;

        // Nothing to do. Idle briefly in case work arrives, then stand down.
        if (Date.now() - s.idleSince > IDLE_MS) break;
        await sleep(Math.min(1000, IDLE_MS));
        continue;
      }

      s.idleSince = Date.now();
      s.sweptAt = undefined;
      await runOne(task, handlers);
    }
  } finally {
    s.running = false;
    s.idleSince = Date.now();
    console.log("[corpus] worker idle");
    // Standing down is fine, but something has to come back for the runs that
    // are waiting on a clock rather than on us.
    scheduleWake();
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __corpusWake: ReturnType<typeof setTimeout> | undefined;
  // eslint-disable-next-line no-var
  var __corpusMorning: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Arms a timer for the next morning routine.
 *
 * scheduleWake cannot carry this: it stands down entirely when no runs are
 * parked, and the whole point of the morning routine is to fire on a day when
 * nothing else is happening. Pinned to globalThis so hot reload replaces it,
 * unref&apos;d so it never keeps a dying process alive, and re-armed after every
 * firing — the callback only kicks the worker, whose idle loop does the due
 * check and the actual queueing, so a spurious firing costs nothing.
 */
function armMorningTimer(): void {
  if (globalThis.__corpusMorning) clearTimeout(globalThis.__corpusMorning);

  // A minute past the hour, so a clock that drifts a few seconds slow does
  // not fire just before the boundary and conclude nothing is due.
  const delay = nextMorningAt(new Date()).getTime() - Date.now() + 60_000;
  const timer = setTimeout(() => {
    globalThis.__corpusMorning = undefined;
    kickWorker();
    armMorningTimer();
  }, delay);
  timer.unref?.();
  globalThis.__corpusMorning = timer;
}

/**
 * Sets a timer to restart the worker when a parked run falls due.
 *
 * This is what makes "resumes automatically" true. The worker loop checks for
 * due runs, but the loop exits once the queue is empty — so without a timer the
 * only things that ever brought a parked run back were an HTTP request that
 * happened to start the worker, or you pressing Resume. A run parked overnight
 * would still be parked in the morning.
 *
 * The timer is pinned to globalThis so a hot reload replaces it rather than
 * stacking, and unref'd so it never keeps the process alive on its own — the
 * server's own listener does that.
 */
export function scheduleWake(): void {
  if (globalThis.__corpusWake) clearTimeout(globalThis.__corpusWake);
  globalThis.__corpusWake = undefined;

  if (!hasParkedRuns()) return;

  const due = nextDueAt();
  // A run parked with no timer at all still gets looked at periodically, in
  // case a key was revived elsewhere.
  const delay = due
    ? Math.min(Math.max(due.getTime() - Date.now(), 5_000), MAX_WAKE_MS)
    : MAX_WAKE_MS;

  const timer = setTimeout(() => {
    globalThis.__corpusWake = undefined;
    const woken = wakeDueRuns();
    if (woken > 0) console.log(`[corpus] ${woken} run(s) came due; picking back up`);
    // Kick regardless: if nothing was due this reschedules the next check.
    kickWorker();
    if (!workerStatus().running) scheduleWake();
  }, delay);

  timer.unref?.();
  globalThis.__corpusWake = timer;

  const when = new Date(Date.now() + delay);
  console.log(`[corpus] next check at ${when.toLocaleTimeString()}`);
}

/** Ten minutes, so a run also recovers from a key revived outside this process. */
const MAX_WAKE_MS = 10 * 60_000;

/**
 * Queues a refresh for entries that have fallen out of date, once the rest of
 * the queue is clear.
 *
 * Runs at most once per idle period and only when something is actually stale,
 * so it settles rather than looping: the entry handler marks each entity fresh,
 * and `staleEntities` ignores anything with no evidence left to write from —
 * the two conditions that could otherwise keep re-queueing the same work.
 */
function sweepStaleEntries(): boolean {
  const s = state();
  if (!getConfig().autoRefreshEntries) return false;
  // One sweep per quiet spell; a second would just re-queue what is running.
  if (s.sweptAt && Date.now() - s.sweptAt < 60_000) return false;
  if (refreshInFlight()) return false;

  const queued = queueStaleEntries("Keeping entries current");
  s.sweptAt = Date.now();
  if (!queued) return false;

  s.idleSince = Date.now();
  console.log(`[corpus] refreshing ${queued.queued} out-of-date entr${queued.queued === 1 ? "y" : "ies"}`);
  return true;
}

/** Fire-and-forget kick. Safe to call on every mutation; it self-deduplicates. */
export function kickWorker(): void {
  const s = state();
  s.idleSince = Date.now();
  if (s.running) return;
  void startWorker().catch((err) => console.error("[corpus] worker crashed", err));
}

export function stopWorker(): void {
  state().stop = true;
}

export function workerStatus() {
  const s = state();
  return { running: s.running, idleFor: Date.now() - s.idleSince };
}
