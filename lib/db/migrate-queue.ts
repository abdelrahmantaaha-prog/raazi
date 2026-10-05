import type Database from "better-sqlite3";

/**
 * Migrations owned by the queue and AI layer (lib/queue.ts, lib/worker.ts,
 * lib/keys.ts). Called from migrate() after the shared migrations; add
 * columns with ALTER TABLE guarded by a column check, or CREATE IF NOT EXISTS.
 */

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function addColumn(db: Database.Database, table: string, column: string, ddl: string) {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  console.log(`[corpus] migrated: ${table}.${column}`);
}

export function migrateQueue(db: Database.Database) {
  // A retry used to be a sleep inside the single worker, so one rate-limited
  // extraction held a question typed into Ask behind it for up to two
  // minutes. Now the task is stamped with when it may be tried again and the
  // loop moves on; claimNext skips anything whose time has not come.
  addColumn(db, "tasks", "not_before", "TEXT");

  // Where a task sits in its run's order when an integer seq cannot say. The
  // two halves of a split chunk have to run after the original's place and
  // before the next task, and they have to run in order — seq is an INTEGER,
  // and renumbering every later task in a five-hundred-task run for the sake
  // of two is the wrong trade. NULL means "just use seq".
  addColumn(db, "tasks", "order_hint", "REAL");

  // Which model actually answered — a Gemini alias resolves to a version, and
  // an entry you may cite should say which one wrote it. Kept here so the UI
  // can show it.
  addColumn(db, "tasks", "model", "TEXT");

  // How many times a failed task has been put back on its own (2026-09-13).
  // A network that kept failing, a provider that was out: the failure was
  // the moment's, not the task's, and the worker now tries again later by
  // itself — a few times, counted here so it cannot go on forever.
  addColumn(db, "tasks", "retries", "INTEGER NOT NULL DEFAULT 0");

  // The same on what the model wrote. A revision outlives the task that made
  // it and the run the task sat in, and "which version of which model wrote
  // this draft" is a question that comes up long after either is listed.
  // NULL when the call that wrote it never said. (entries.model has been in
  // the schema since the start; mentions.model is added in migrate.ts, ahead
  // of the live_mentions rebuild; briefs.model in migrate-feeds.ts.)
  addColumn(db, "entry_revisions", "model", "TEXT");
}

/**
 * Clears the copies the planning step queued before it learned to look at
 * what was already waiting (see staleEntities' `notQueued`). For each entity
 * one entry stays — one with a reason of its own (a forced rewrite, the
 * upgrade, a verification flag) if there is one, else the oldest run's — and
 * every other plain copy is superseded. Copies with a reason are never. Runs left
 * with nothing to do are settled the way settleRun would.
 */
export function supersedeDuplicateEntries(db: Database.Database) {
  const rows = db
    .prepare(
      `WITH live AS (
         SELECT t.id, t.state, t.payload_json, entity,
                ROW_NUMBER() OVER (
                  PARTITION BY entity
                  -- A copy with a reason of its own is the one kept, wherever it sits.
                  ORDER BY t.payload_json = json_object('entityId', entity), t.run_id, t.id
                ) AS place
           FROM (SELECT *, json_extract(payload_json, '$.entityId') AS entity FROM tasks) t
           JOIN runs r ON r.id = t.run_id
          WHERE t.kind = 'entry' AND t.state IN ('pending', 'running')
            AND r.state <> 'paused_user')
       UPDATE tasks
          SET state = 'superseded', updated_at = datetime('now'),
              last_error = 'An earlier copy of this entry was already queued.'
        WHERE id IN (SELECT id FROM live
                      WHERE place > 1 AND state = 'pending'
                        AND payload_json = json_object('entityId', entity))
    RETURNING run_id`
    )
    .all() as { run_id: number }[];
  if (rows.length === 0) return;

  const runs = [...new Set(rows.map((r) => r.run_id))];
  const open = db.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE run_id = ? AND state IN ('pending','running')"
  );
  const failed = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE run_id = ? AND state = 'failed'");
  const settle = db.prepare(
    "UPDATE runs SET state = ?, updated_at = datetime('now') WHERE id = ? AND state != 'paused_user'"
  );
  const ready = db.prepare(
    `UPDATE sources SET status = CASE WHEN ? THEN 'failed' ELSE 'ready' END
      WHERE id = (SELECT source_id FROM runs WHERE id = ?)
        AND status = 'extracting'
        AND NOT EXISTS (
          SELECT 1 FROM tasks t JOIN runs r ON r.id = t.run_id
           WHERE r.source_id = sources.id AND t.state IN ('pending','running'))`
  );
  let settled = 0;
  for (const runId of runs) {
    if ((open.get(runId) as { n: number }).n > 0) continue;
    const anyFailed = (failed.get(runId) as { n: number }).n > 0;
    settle.run(anyFailed ? "failed" : "done", runId);
    ready.run(anyFailed ? 1 : 0, runId);
    settled++;
  }
  console.log(
    `[corpus] superseded ${rows.length} duplicate entr${rows.length === 1 ? "y" : "ies"} across ${runs.length} run(s); ${settled} run(s) had nothing else left`
  );
}
