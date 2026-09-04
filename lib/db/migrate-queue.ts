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
}
