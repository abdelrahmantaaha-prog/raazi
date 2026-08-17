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
 *   1 — the reading pipeline, which nobody is watching in real time
 *   2 — decoration, which can always wait for everything else
 *
 * Within a band it is still first come, first served, so nothing starves and a
 * long ingest still runs in the order it was queued.
 */
export const PRIORITY: Record<string, number> = {
  ask: 0,
  cards: 0,
  factcheck: 0,
  portrait: 2,
  plan_portraits: 2,
};
const DEFAULT_PRIORITY = 1;

const PRIORITY_SQL = `CASE t.kind ${Object.entries(PRIORITY)
  .map(([kind, p]) => `WHEN '${kind}' THEN ${p}`)
  .join(" ")} ELSE ${DEFAULT_PRIORITY} END`;

export function claimNext(): Task | undefined {
  return db()
    .prepare(
      `UPDATE tasks
          SET state = 'running', attempts = attempts + 1, updated_at = datetime('now')
        WHERE id = (
          SELECT t.id FROM tasks t
            JOIN runs r ON r.id = t.run_id
           WHERE t.state = 'pending'
             AND r.state IN ('queued', 'running')
           ORDER BY ${PRIORITY_SQL}, r.id, t.seq
           LIMIT 1
        )
    RETURNING *`
    )
    .get() as Task | undefined;
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
      "UPDATE tasks SET state='pending', last_error=?, updated_at=datetime('now') WHERE id=?"
    )
    .run(error ?? null, taskId);
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

export function resumeRun(runId: number) {
  tx(() => {
    // A task that was mid-flight when the run was paused goes back in the queue.
    db()
      .prepare("UPDATE tasks SET state='pending' WHERE run_id=? AND state='running'")
      .run(runId);
    db()
      .prepare(
        `UPDATE runs SET state='queued', last_error=NULL, resume_at=NULL,
                updated_at=datetime('now') WHERE id=?`
      )
      .run(runId);
  });
}

/** Retry every task that failed outright, without redoing completed work. */
export function retryFailedTasks(runId: number): number {
  return tx(() => {
    const r = db()
      .prepare(
        "UPDATE tasks SET state='pending', attempts=0 WHERE run_id=? AND state='failed'"
      )
      .run(runId);
    if (r.changes > 0) {
      db().prepare("UPDATE runs SET state='queued' WHERE id=?").run(runId);
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
  const row = db()
    .prepare(
      `SELECT MIN(resume_at) AS due FROM runs
        WHERE state='paused_quota' AND resume_at IS NOT NULL`
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
  db()
    .prepare("UPDATE runs SET state=?, updated_at=datetime('now') WHERE id=?")
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
}

export function listRuns(limit = 50): RunProgress[] {
  return db()
    .prepare(
      `SELECT r.*, s.title AS source_title,
              (SELECT COUNT(*) FROM tasks t WHERE t.run_id=r.id) AS total,
              (SELECT COUNT(*) FROM tasks t WHERE t.run_id=r.id AND t.state IN ('done','skipped','superseded')) AS done,
              (SELECT COUNT(*) FROM tasks t WHERE t.run_id=r.id AND t.state='failed') AS failed,
              (SELECT COUNT(*) FROM tasks t WHERE t.run_id=r.id AND t.state IN ('pending','running')) AS pending
         FROM runs r LEFT JOIN sources s ON s.id = r.source_id
        ORDER BY r.id DESC LIMIT ?`
    )
    .all(limit) as RunProgress[];
}

export function getRun(runId: number): RunProgress | undefined {
  return listRuns(1000).find((r) => r.id === runId);
}

/** True when the run has spent its allowance. */
export function overBudget(runId: number): boolean {
  const r = db()
    .prepare("SELECT tokens_in, tokens_out, budget_cap FROM runs WHERE id=?")
    .get(runId) as { tokens_in: number; tokens_out: number; budget_cap: number | null } | undefined;
  if (!r?.budget_cap) return false;
  return r.tokens_in + r.tokens_out >= r.budget_cap;
}
