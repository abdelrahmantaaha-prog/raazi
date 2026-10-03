import { db, tx } from "./db";
import type { Run, RunState, Task, TaskKind } from "./types";

const now = () => new Date().toISOString();

export function createRun(opts: {
  sourceId?: number | null;
  kind: string;
  label?: string;
  budgetCap?: number | null;
}): number {
  const info = db()
    .prepare(
      `INSERT INTO runs (source_id, kind, label, state, budget_cap)
       VALUES (?, ?, ?, 'queued', ?)`
    )
    .run(opts.sourceId ?? null, opts.kind, opts.label ?? null, opts.budgetCap || null);
  return Number(info.lastInsertRowid);
}

export function enqueue(
  runId: number,
  tasks: { kind: TaskKind; payload: unknown; seq?: number }[]
): void {
  if (tasks.length === 0) return;
  const nextSeq =
    (db()
      .prepare("SELECT COALESCE(MAX(seq), -1) AS m FROM tasks WHERE run_id = ?")
      .get(runId) as { m: number }).m + 1;

  const stmt = db().prepare(
    "INSERT INTO tasks (run_id, seq, kind, payload_json) VALUES (?, ?, ?, ?)"
  );
  tx(() => {
    tasks.forEach((t, i) => {
      stmt.run(runId, t.seq ?? nextSeq + i, t.kind, JSON.stringify(t.payload));
    });
  });
}

/**
 * Take the next unit of work and mark it running in one statement. Doing the
 * select and the update separately would let two workers grab the same task;
 * this cannot.
 */
/**
 * What jumps the queue.
 *
 * Strict first-come order is right for a pipeline and wrong for a person: a
 * question typed into Ask would sit behind five hundred re-extractions, which
 * can be twenty minutes, and you are sitting there watching it. So work is
 * ordered by who is waiting on it.
 *
 *   0 — you are looking at the screen right now
 *   1 — the feeds' articles, fetched and chunked into the inbox; free, and
 *       what the inbox is waiting on
 *   2 — the reading pipeline, which nobody is watching in real time
 *   3 — decoration, which can always wait for everything else
 *
 * Within a band it is still first come, first served, so nothing starves and a
 * long ingest still runs in the order it was queued.
 *
 * The fetch used to share the reading's band, and within a band the older run
 * goes first — so three hundred articles a morning's polls had found sat
 * behind an older ingest whose every model call was failing, and the inbox
 * stayed empty for an hour while the worker retried entries nobody was
 * waiting for. A fetch costs no tokens; nothing the reading does should be
 * ahead of it.
 */
export const PRIORITY: Record<string, number> = {
  factcheck: 0,
  webcheck: 0,
  // The brief is what you opened the app for; the poll that feeds it comes
  // first of all, since a brief written before the morning's articles are in
  // is a brief about yesterday.
  poll: 0,
  plan_polls: 0,
  brief: 0,
  // Asked for with a click on the brief, and wanted while you are still reading it.
  expand: 0,
  fetch_item: 1,
  // Writing an entry is the slow step — minutes a time with Opus — and it
  // queued inside the batch that asked for it, so 27 entries from four kept
  // articles held seven later articles and a whole folder unread for hours
  // (3 Oct 2026). Reading comes first now and entries follow, in the quiet.
  // The brief is untouched: it stays at the front.
  entry: 3,
  portrait: 3,
  plan_portraits: 3,
};
const DEFAULT_PRIORITY = 2;

const KIND_PRIORITY_SQL = `CASE t.kind ${Object.entries(PRIORITY)
  .map(([kind, p]) => `WHEN '${kind}' THEN ${p}`)
  .join(" ")} ELSE ${DEFAULT_PRIORITY} END`;

/**
 * A batch you marked "Do this first" has its reading taken right after the
 * brief and the news fetching, ahead of every other batch. Its entries still
 * wait their turn at the back: what you are in a hurry for is the reading.
 */
const PRIORITY_SQL = `CASE WHEN r.first = 1 AND t.kind <> 'entry' AND ${KIND_PRIORITY_SQL} > 0
  THEN 0.5 ELSE ${KIND_PRIORITY_SQL} END`;

/** Puts a batch's reading ahead of every other batch's, or back in line. */
export function setRunFirst(runId: number, first: boolean) {
  db().prepare("UPDATE runs SET first=? WHERE id=?").run(first ? 1 : 0, runId);
}

export function claimNext(): Task | undefined {
  // A task waiting out a retry (not_before) is passed over, not slept on:
  // the loop goes on to whatever else is due, which is how a question typed
  // into Ask gets answered while an extraction waits for its rate limit.
  // order_hint, where set, is a fractional place in the run's order — the
  // halves of a split chunk sit between the original's seq and the next.
  return db()
    .prepare(
      `UPDATE tasks
          SET state = 'running', attempts = attempts + 1, updated_at = datetime('now')
        WHERE id = (
          SELECT t.id FROM tasks t
            JOIN runs r ON r.id = t.run_id
           WHERE t.state = 'pending'
             AND r.state IN ('queued', 'running')
             AND (t.not_before IS NULL OR t.not_before <= ?)
           ORDER BY ${PRIORITY_SQL}, r.id, COALESCE(t.order_hint, t.seq), t.id
           LIMIT 1
        )
    RETURNING *`
    )
    .get(now()) as Task | undefined;
}

/** Marks the task done and bills its tokens to the run, atomically with the
 *  caller's own writes when invoked inside a transaction. */
export function finishTask(
  taskId: number,
  runId: number,
  usage: { tokensIn: number; tokensOut: number },
  state: "done" | "skipped" = "done",
  note?: string
) {
  db()
    .prepare(
      `UPDATE tasks SET state = ?, tokens_in = ?, tokens_out = ?,
              last_error = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(state, usage.tokensIn, usage.tokensOut, note ?? null, taskId);
  db()
    .prepare(
      `UPDATE runs SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
              state = CASE WHEN state = 'queued' THEN 'running' ELSE state END,
              updated_at = datetime('now')
        WHERE id = ?`
    )
    .run(usage.tokensIn, usage.tokensOut, runId);
}

export function releaseTask(taskId: number, error?: string) {
  db()
    .prepare(
      "UPDATE tasks SET state='pending', last_error=?, not_before=NULL, updated_at=datetime('now') WHERE id=?"
    )
    .run(error ?? null, taskId);
}

/**
 * Back in the queue, but not before the given moment. This is what a retry
 * with a real wait behind it becomes — the worker used to sleep the wait out
 * in the loop, and everything behind the task, whatever its priority, slept
 * with it.
 */
export function deferTask(taskId: number, notBefore: Date, error?: string) {
  db()
    .prepare(
      "UPDATE tasks SET state='pending', last_error=?, not_before=?, updated_at=datetime('now') WHERE id=?"
    )
    .run(error ?? null, notBefore.toISOString(), taskId);
}

/** Records which model actually answered a task, when a call reported it. */
export function noteTaskModel(taskId: number, model: string) {
  db().prepare("UPDATE tasks SET model=? WHERE id=?").run(model.slice(0, 120), taskId);
}

/**
 * Gives back the attempt that claimNext charged for a turn the task never
 * got to take.
 *
 * claimNext counts every claim, and classify() reads that count as the
 * task's retry budget: two strikes fail an unrecognised error outright,
 * five fail a 5xx or a network blip. But a task set aside because every
 * model was busy, or because the ring was rate limited, has not tried
 * anything — and under the quality floor that wait is the normal state of
 * the entry stage. By 20 September 2026 entry tasks were being claimed an
 * average of 30 times each, to a maximum of 97, every one of them arriving
 * at its first real error with the whole budget already spent.
 *
 * So a wait that was the ring's fault hands the attempt back, and the
 * count means again what classify() thinks it means: how many times this
 * task has genuinely been tried.
 */
export function refundAttempt(taskId: number) {
  db()
    .prepare("UPDATE tasks SET attempts = MAX(attempts - 1, 0) WHERE id = ?")
    .run(taskId);
}

export function failTask(taskId: number, error: string) {
  db()
    .prepare(
      "UPDATE tasks SET state='failed', last_error=?, updated_at=datetime('now') WHERE id=?"
    )
    .run(error.slice(0, 1000), taskId);
}

export function supersedeTask(taskId: number, note: string) {
  db()
    .prepare(
      "UPDATE tasks SET state='superseded', last_error=?, updated_at=datetime('now') WHERE id=?"
    )
    .run(note, taskId);
}

export function pauseRun(runId: number, state: RunState, reason: string, resumeAt?: Date) {
  db()
    .prepare(
      `UPDATE runs SET state=?, last_error=?, resume_at=?, updated_at=datetime('now')
        WHERE id=?`
    )
    .run(state, reason, resumeAt?.toISOString() ?? null, runId);
}

/**
 * Puts a run back in the queue.
 *
 * A run you paused yourself stays paused unless the caller says `force` —
 * that is the Resume button speaking, and nothing else gets to speak for
 * you. Every other paused state is the app's own doing (quota, key, budget)
 * and any caller may lift it. Returns whether anything changed.
 */
export function resumeRun(runId: number, opts: { force?: boolean } = {}): boolean {
  return tx(() => {
    const run = db().prepare("SELECT state FROM runs WHERE id=?").get(runId) as
      | { state: RunState }
      | undefined;
    if (!run) return false;
    if (run.state === "paused_user" && !opts.force) return false;

    // A task that was mid-flight when the run was paused goes back in the queue.
    db()
      .prepare("UPDATE tasks SET state='pending', not_before=NULL WHERE run_id=? AND state='running'")
      .run(runId);
    db()
      .prepare(
        `UPDATE runs SET state='queued', last_error=NULL, resume_at=NULL,
                updated_at=datetime('now') WHERE id=?`
      )
      .run(runId);
    return true;
  });
}

/** The kinds a failure is worth retrying unasked: model work, where the
 *  failure was almost always the provider's moment rather than the task's. */
const RETRIABLE = ["entry", "verify", "extract", "resolve", "tag", "enhance", "identity", "context", "coherence", "sweep"];
/** How long a failure rests before it is tried again, and how many times. */
export const AUTO_RETRY_AFTER_MINUTES = 30;
export const AUTO_RETRY_LIMIT = 3;

/**
 * Puts failed model tasks back on their own, a while after they failed.
 *
 * "Network kept failing" and "the provider kept returning 503" are verdicts
 * on an afternoon, not on a passage — and an entry that failed to write at
 * three used to stay failed until someone found the run and pressed Retry.
 * Now the worker does that itself: a task that has rested half an hour goes
 * back to pending, a few times, counted on the row so a genuinely broken
 * task cannot be retried forever. Returns how many went back.
 */
export function retryFailedAutomatically(
  opts: { olderThanMinutes?: number; limit?: number } = {}
): number {
  const minutes = opts.olderThanMinutes ?? AUTO_RETRY_AFTER_MINUTES;
  const limit = opts.limit ?? AUTO_RETRY_LIMIT;
  return tx(() => {
    const rows = db()
      .prepare(
        `UPDATE tasks
            SET state='pending', attempts=0, not_before=NULL, retries=retries+1,
                last_error='Retried on its own after: ' || COALESCE(last_error, ''),
                updated_at=datetime('now')
          WHERE state='failed'
            AND kind IN (${RETRIABLE.map((k) => `'${k}'`).join(",")})
            AND retries < ?
            AND datetime(updated_at) < datetime('now', ?)
            -- An output cut short is a verdict on the passage, not the
            -- afternoon: the same evidence asked the same way hits the same
            -- ceiling, and an entry that would not fit was retried nine
            -- times, each a full call, before this line existed.
            AND COALESCE(last_error, '') NOT LIKE '%Output was truncated%'
        RETURNING run_id`
      )
      .all(limit, `-${minutes} minutes`) as { run_id: number }[];
    const runs = [...new Set(rows.map((r) => r.run_id))];
    for (const runId of runs) {
      db()
        .prepare(
          `UPDATE runs SET state='queued', updated_at=datetime('now')
            WHERE id=? AND state IN ('failed', 'done')`
        )
        .run(runId);
    }
    return rows.length;
  });
}

/** Whether any failed task is still owed a retry, so the worker keeps a clock for it. */
export function hasRetryableFailures(limit = AUTO_RETRY_LIMIT): boolean {
  return (
    (
      db()
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks WHERE state='failed' AND retries < ?
              AND kind IN (${RETRIABLE.map((k) => `'${k}'`).join(",")})
              AND COALESCE(last_error, '') NOT LIKE '%Output was truncated%'`
        )
        .get(limit) as { n: number }
    ).n > 0
  );
}

/**
 * Retry every task that failed outright, without redoing completed work.
 * The tasks go back to pending either way; the run itself only leaves a
 * user-imposed pause when told to, for the reason resumeRun gives.
 */
export function retryFailedTasks(runId: number, opts: { force?: boolean } = {}): number {
  return tx(() => {
    const r = db()
      .prepare(
        "UPDATE tasks SET state='pending', attempts=0, not_before=NULL WHERE run_id=? AND state='failed'"
      )
      .run(runId);
    if (r.changes > 0) {
      db()
        .prepare(
          `UPDATE runs SET state='queued', updated_at=datetime('now')
            WHERE id=? AND (state != 'paused_user' OR ?)`
        )
        .run(runId, opts.force ? 1 : 0);
    }
    return r.changes;
  });
}

/** Any run whose auto-resume time has arrived goes back in the queue. */
export function wakeDueRuns(): number {
  const r = db()
    .prepare(
      `UPDATE runs SET state='queued', resume_at=NULL, updated_at=datetime('now')
        WHERE state='paused_quota' AND resume_at IS NOT NULL AND resume_at <= ?`
    )
    .run(now());
  return r.changes;
}

/**
 * When the next parked run is due, so the process can set a timer for it.
 *
 * Without this the only thing that ever noticed a run's time had come was the
 * worker loop — and the loop stands down when idle, so a run parked overnight
 * stayed parked until something else happened to start the worker.
 */
export function nextDueAt(): Date | undefined {
  // Two kinds of clock: a run parked on quota, and a task deferred for a
  // retry inside a run that is otherwise live. Whichever is sooner.
  const row = db()
    .prepare(
      `SELECT MIN(due) AS due FROM (
         SELECT resume_at AS due FROM runs
          WHERE state='paused_quota' AND resume_at IS NOT NULL
         UNION ALL
         SELECT t.not_before AS due FROM tasks t JOIN runs r ON r.id = t.run_id
          WHERE t.state='pending' AND t.not_before IS NOT NULL
            AND r.state IN ('queued','running')
       )`
    )
    .get() as { due: string | null };
  return row.due ? new Date(row.due) : undefined;
}

/** True when a run is parked waiting on quota, whether or not it is due yet. */
export function hasParkedRuns(): boolean {
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM runs WHERE state='paused_quota'")
    .get() as { n: number };
  return row.n > 0;
}

/** True when a live run has a task waiting out a retry, due or not. */
export function hasDeferredTasks(): boolean {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t JOIN runs r ON r.id = t.run_id
        WHERE t.state='pending' AND t.not_before IS NOT NULL
          AND r.state IN ('queued','running')`
    )
    .get() as { n: number };
  return row.n > 0;
}

/**
 * Releases every quota-parked run regardless of its timer. Called when a key
 * becomes usable again — you added one, or retried one by hand — because the
 * stored resume time was only ever a guess about when that would happen.
 */
export function wakeParkedRuns(): number {
  return db()
    .prepare(
      `UPDATE runs SET state='queued', resume_at=NULL, updated_at=datetime('now')
        WHERE state='paused_quota'`
    )
    .run().changes;
}

/** A run with nothing left pending is finished. */
export function settleRun(runId: number): boolean {
  const left = db()
    .prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE run_id=? AND state IN ('pending','running')"
    )
    .get(runId) as { n: number };
  if (left.n > 0) return false;
  const failed = db()
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE run_id=? AND state='failed'")
    .get(runId) as { n: number };
  // A run you paused keeps saying so, even once its last in-flight task has
  // landed: "done" would be the app overruling you, and Resume is the only
  // thing that should.
  db()
    .prepare(
      "UPDATE runs SET state=?, updated_at=datetime('now') WHERE id=? AND state != 'paused_user'"
    )
    .run(failed.n > 0 ? "failed" : "done", runId);

  // The source is only readable once nothing is still queued against it —
  // including work a later run added, such as an on-demand entry.
  db()
    .prepare(
      `UPDATE sources SET status = CASE WHEN ? THEN 'failed' ELSE 'ready' END
        WHERE id = (SELECT source_id FROM runs WHERE id = ?)
          AND status = 'extracting'
          AND NOT EXISTS (
            SELECT 1 FROM tasks t JOIN runs r ON r.id = t.run_id
             WHERE r.source_id = sources.id AND t.state IN ('pending','running')
          )`
    )
    .run(failed.n > 0 ? 1 : 0, runId);
  return true;
}

export interface RunProgress extends Run {
  total: number;
  done: number;
  failed: number;
  pending: number;
  source_title: string | null;
  /** Every model that answered a task in this run, comma-separated and
   *  deduplicated, in the order SQLite met them; null until one has. Derived
   *  from tasks.model rather than stored, so it is right for old runs too. */
  models: string | null;
}

const RUN_PROGRESS_SQL = `SELECT r.*, s.title AS source_title,
              (SELECT group_concat(DISTINCT t.model) FROM tasks t WHERE t.run_id=r.id AND t.model IS NOT NULL) AS models,
              (SELECT COUNT(*) FROM tasks t WHERE t.run_id=r.id) AS total,
              (SELECT COUNT(*) FROM tasks t WHERE t.run_id=r.id AND t.state IN ('done','skipped','superseded')) AS done,
              (SELECT COUNT(*) FROM tasks t WHERE t.run_id=r.id AND t.state='failed') AS failed,
              (SELECT COUNT(*) FROM tasks t WHERE t.run_id=r.id AND t.state IN ('pending','running')) AS pending
         FROM runs r LEFT JOIN sources s ON s.id = r.source_id`;

/**
 * A task that fell through providers records "a, b" in one cell, so the
 * DISTINCT above can still repeat a name across tasks; this folds the list
 * back to one mention of each.
 */
function tidyModels(row: RunProgress): RunProgress {
  const names = [...new Set((row.models ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  row.models = names.length ? names.join(", ") : null;
  return row;
}

/**
 * Every run still to finish, however old, and the newest `limit` beside them.
 * It used to be the newest fifty only, and the morning's feed checks make a
 * run each — sixty-seven of them between 11:37 and 19:45 on 3 Oct 2026 — so
 * nine runs still waiting to be read fell off the Activity list while they
 * were still in the queue.
 */
export function listRuns(limit = 50): RunProgress[] {
  return (
    db()
      .prepare(
        `${RUN_PROGRESS_SQL}
          WHERE r.state NOT IN ('done', 'failed')
             OR r.id IN (SELECT id FROM runs ORDER BY id DESC LIMIT ?)
          ORDER BY r.id DESC`
      )
      .all(limit) as RunProgress[]
  ).map(tidyModels);
}

/** One run with its progress. Used to be the thousand-run listing filtered
 *  in memory — four subselects per run, on every poll of one run's page. */
export function getRun(runId: number): RunProgress | undefined {
  const row = db()
    .prepare(`${RUN_PROGRESS_SQL} WHERE r.id = ?`)
    .get(runId) as RunProgress | undefined;
  return row ? tidyModels(row) : undefined;
}

/** True when the run has spent its allowance. */
export function overBudget(runId: number): boolean {
  const r = db()
    .prepare("SELECT tokens_in, tokens_out, budget_cap FROM runs WHERE id=?")
    .get(runId) as { tokens_in: number; tokens_out: number; budget_cap: number | null } | undefined;
  if (!r?.budget_cap) return false;
  return r.tokens_in + r.tokens_out >= r.budget_cap;
}
