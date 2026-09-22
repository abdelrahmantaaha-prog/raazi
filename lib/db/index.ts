import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { migrate } from "./migrate";
import { activeDir } from "../disciplines";

/**
 * The library this process is working in.
 *
 * Settled once, at startup, from the discipline the registry says is open —
 * and never again while the process lives. Switching discipline is a restart
 * for exactly that reason: a constant cannot go stale, a cached connection
 * cannot point at yesterday's database, and no half of the app can be looking
 * at one library while another half looks at the next. See lib/disciplines.ts.
 *
 * CORPUS_DATA_DIR still wins, so a test run points at a scratch library.
 */
export const DATA_DIR = activeDir();
export const SOURCES_DIR = path.join(DATA_DIR, "sources");
const DB_PATH = path.join(DATA_DIR, "corpus.db");
const PID_PATH = path.join(DATA_DIR, "corpus.pid");

/**
 * How old the pid file may be before its pid is disbelieved, and how often a
 * live worker refreshes it to stay inside that. Windows reuses pids freely:
 * a server that crashed on Monday can leave a number that belongs to a
 * browser tab by Tuesday, and `kill(pid, 0)` cannot tell them apart —
 * comparing process start times would, but on Windows that means shelling
 * out to WMI on every database open, which is not cheap enough for a guard.
 * So the claim is a lease instead: the worker re-touches the file every few
 * minutes while it runs, and a file nobody has touched in a day is treated
 * as a crash's leftovers whatever pid it names.
 */
const PID_STALE_MS = 24 * 60 * 60_000;
const PID_REFRESH_MS = 5 * 60_000;

/**
 * Whether some other Corpus process is alive on this library right now.
 *
 * The worker claims the pid file when it starts (see claimWorkerPid); a crash
 * leaves the file behind, which is why the answer comes from probing the pid
 * rather than from the file existing. Signal 0 is a liveness test, not a
 * signal: it throws for a pid that is gone and returns for one that is not.
 * EPERM would also mean "alive", but everything here runs as the same user,
 * so the catch treating it as dead is acceptable rather than subtle.
 */
function anotherInstanceAlive(): number | null {
  try {
    if (Date.now() - fs.statSync(PID_PATH).mtimeMs > PID_STALE_MS) return null;
    const pid = Number(fs.readFileSync(PID_PATH, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

let lastClaimAt = 0;

/**
 * Records this process as the one running the worker. Called by startWorker,
 * not by open(): merely reading the library — a test, a script, a second dev
 * server — must not claim to own its queue. Called again from the worker
 * loop, where it is a cheap no-op until the lease is due for renewal.
 */
export function claimWorkerPid(): void {
  if (Date.now() - lastClaimAt < PID_REFRESH_MS) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PID_PATH, String(process.pid), "utf8");
    lastClaimAt = Date.now();
  } catch {
    // Losing the claim costs the guard, not the app.
  }
}

/**
 * Next's dev server re-evaluates modules on hot reload. Without a global pin we
 * would open a new SQLite handle (and later, a second worker) on every edit.
 */
declare global {
  // eslint-disable-next-line no-var
  var __corpusDb: Database.Database | undefined;
}

function open(): Database.Database {
  fs.mkdirSync(SOURCES_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  const schema = fs.readFileSync(
    path.join(process.cwd(), "lib", "db", "schema.sql"),
    "utf8"
  );
  db.exec(schema);
  migrate(db);

  // Crash recovery is only safe when we are alone. Every `tsx scripts/…` and
  // stray `npm run dev` opens this same database, and resetting `running`
  // tasks while the real worker is mid-call on one of them gets that task
  // claimed and executed twice — duplicate mentions, duplicate token spend.
  const other = anotherInstanceAlive();
  if (other !== null) {
    console.log(
      `[corpus] another Corpus process (pid ${other}) is using this library — leaving its in-flight tasks alone`
    );
  } else {
    recoverOrphanedTasks(db);
  }
  return db;
}

/**
 * Crash recovery. A task left in `running` means the process died mid-call —
 * the transaction that would have written its results never committed, so the
 * work is simply undone. Put it back in the queue.
 *
 * Guarded by a liveness check on the pid file above: "the process died" is
 * only a valid inference when no other Corpus process is alive.
 */
function recoverOrphanedTasks(db: Database.Database) {
  const orphaned = db
    .prepare("UPDATE tasks SET state='pending' WHERE state='running'")
    .run();
  const runs = db
    .prepare("UPDATE runs SET state='queued' WHERE state='running'")
    .run();
  if (orphaned.changes > 0 || runs.changes > 0) {
    console.log(
      `[corpus] recovered ${orphaned.changes} interrupted task(s) across ${runs.changes} run(s)`
    );
  }
}

export function db(): Database.Database {
  if (!globalThis.__corpusDb) globalThis.__corpusDb = open();
  return globalThis.__corpusDb;
}

/** Runs `fn` inside a transaction; nothing is visible until it returns. */
export function tx<T>(fn: () => T): T {
  return db().transaction(fn)();
}
