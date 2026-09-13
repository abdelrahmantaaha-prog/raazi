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
