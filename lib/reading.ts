import { db, tx } from "./db";
import { getConfig } from "./config";
import { createRun, enqueue } from "./queue";
import { ENTITY_TYPES } from "./types";

// Deliberately no import of lib/worker here. The ingest and OCR paths both need
// `queueExtractions`, and the worker imports the handlers, which import those —
// so importing kickWorker would close the loop. Callers start the worker.

/**
 * Reading position, and what it sets in motion.
 *
 * Two things live here that used to be tangled together elsewhere. The first is
 * simply *how far through a source you are* — which the reader used to hold in
 * a React state variable, so it existed while the reader was open and was zero
 * everywhere else, including on the shelf.
 *
 * The second is the reason progress is worth storing at all. A 600-page book
 * used to be handed to the model in its entirety the moment it was added: five
 * hundred calls, most of them about pages you had not read and might never
 * read, all spent before you opened it. Read-along inverts that. The book is
 * chunked and readable immediately, and a passage is only sent for extraction
 * once you have actually read past it. The pedia then grows at the speed you
 * do, which is also the only speed at which you can check it.
 */

/**
 * What reading a source does to the pedia.
 *
 *   eager  the whole thing is handed to the model when it arrives. Right for
 *          an article: it is one or two calls.
 *   along  passages are read as you get to them, so a 600-page book costs at
 *          the speed you read rather than all at once on the day you add it.
 *   shelf  nothing is ever extracted from it. The text is chunked, readable,
 *          searchable and quotable by hand — it simply never becomes evidence
 *          and never feeds an entry.
 *
 * "shelf" exists because not everything you want to keep is research. A novel,
 * an art book, a catalogue you are reading for pleasure: putting those through
 * extraction gives you a pedia full of characters and painters standing beside
 * the people you actually cover, and it costs the most expensive stage in the
 * application to do it.
 */
export type ReadMode = "eager" | "along" | "shelf";

/**
 * Above this many passages a source is treated as a book: worth reading along
 * with rather than swallowing whole. Below it the whole thing is one or two
 * calls, and waiting for you to scroll past an article you have already
 * finished reading would just be pedantry.
 */
const ALONG_THRESHOLD = 8;

/**
 * How far ahead of you to read. Extraction is not instant, so a passage queued
 * the moment you reach it produces an entry some minutes after you have moved
 * on. Running a little ahead means the pedia is usually ready when you look.
 */
const LOOKAHEAD = 2;

export interface ReadModeInput {
  read_mode?: string | null;
  chunks?: number;
}

/** The stored choice if there is one, otherwise the guess. */
export function readModeOf(s: ReadModeInput): ReadMode {
  if (s.read_mode === "eager" || s.read_mode === "along" || s.read_mode === "shelf") return s.read_mode;
  return guessReadMode(s);
}

export function guessReadMode(s: ReadModeInput): ReadMode {
  return (s.chunks ?? 0) > ALONG_THRESHOLD ? "along" : "eager";
}

export interface Position {
  chunkId: number | null;
  offset: number;
  /** Passages read since the last save. Progress is computed from these. */
  read?: number[];
}

/**
 * Writes where you are.
 *
 * `furthest_chunk` only ever moves forward. Scrolling back to check something
 * on page 20 should not un-read pages 21 through 400, and without the ratchet
 * it would: read-along would see the earlier position and think there was
 * nothing new to do, then re-queue everything when you scrolled down again.
 */
export function recordPosition(sourceId: number, pos: Position): void {
  const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

  // `read` is the set of passages the reader reports having actually dwelled
  // on. Those are what progress is computed from; the scroll fraction is not
  // stored at all any more, because it was never a measure of reading.
  if (pos.read?.length) markRead(sourceId, pos.read, "read");

  // A position in some other book is not a position in this one. Looked up
  // first so a foreign id neither becomes the bookmark nor moves the mark.
  const seq = pos.chunkId === null ? null : seqOf(sourceId, pos.chunkId);
  const chunkId = seq === null ? null : pos.chunkId;

  db()
    .prepare(
      `UPDATE sources
          SET bookmark_chunk  = COALESCE(?, bookmark_chunk),
              bookmark_offset = ?,
              read_at         = datetime('now')
        WHERE id = ?`
    )
    .run(chunkId, clamp(pos.offset), sourceId);

  recomputeProgress(sourceId);

  if (seq !== null && chunkId !== null) advanceFurthest(sourceId, chunkId, seq);
}

/**
 * Records passages as read.
 *
 * Weighted by length when progress is computed, so a book of uneven chapters
 * does not jump five per cent for a half-page passage and one per cent for a
 * long one.
 */
export function markRead(sourceId: number, chunkIds: number[], how: "read" | "marked"): number {
  if (!chunkIds.length) return 0;
  // Only passages of *this* source. The ids arrive from the browser, and a
  // chunk id from another book satisfies the foreign key just as well — it
  // would count as read here, and read-along would then hand that other book
  // to the model. The ownership check is in the statement, not around it.
  const stmt = db().prepare(
    `INSERT INTO read_passages (source_id, chunk_id, how)
     SELECT ?, id, ? FROM chunks WHERE id = ? AND source_id = ?
       ON CONFLICT(source_id, chunk_id) DO NOTHING`
  );
  return tx(() => {
    let n = 0;
    for (const id of chunkIds) {
      if (!Number.isInteger(id) || id <= 0) continue;
      n += stmt.run(sourceId, how, id, sourceId).changes;
    }
    return n;
  });
}

/** Everything up to and including this passage counts as read. */
export function markReadThrough(sourceId: number, chunkId: number): number {
  const ids = (
    db()
      .prepare(
        `SELECT id FROM chunks
          WHERE source_id = ?
            AND seq <= (SELECT seq FROM chunks WHERE id = ? AND source_id = ?)`
      )
      .all(sourceId, chunkId, sourceId) as { id: number }[]
  ).map((c) => c.id);
  const n = markRead(sourceId, ids, "marked");
  recomputeProgress(sourceId);
  return n;
}

/** Forgets that a passage was read. */
export function unmarkRead(sourceId: number, chunkId: number): void {
  db().prepare("DELETE FROM read_passages WHERE source_id=? AND chunk_id=?").run(sourceId, chunkId);
  recomputeProgress(sourceId);
}

/**
 * Progress as the share of the text you have read, by length.
 *
 * Stored rather than derived so the shelf can show it without counting
 * characters across every book on every render.
 */
export function recomputeProgress(sourceId: number): number {
  const row = db()
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(c.text)), 0) AS total,
              COALESCE(SUM(CASE WHEN r.chunk_id IS NULL THEN 0 ELSE LENGTH(c.text) END), 0) AS done
         FROM chunks c
    LEFT JOIN read_passages r ON r.chunk_id = c.id AND r.source_id = c.source_id
        WHERE c.source_id = ?`
    )
    .get(sourceId) as { total: number; done: number };

  const progress = row.total > 0 ? row.done / row.total : 0;
  db().prepare("UPDATE sources SET progress=? WHERE id=?").run(progress, sourceId);
  return progress;
}

/** Which passages of this source are already read. */
export function readPassages(sourceId: number): number[] {
  return (
    db()
      .prepare("SELECT chunk_id FROM read_passages WHERE source_id=?")
      .all(sourceId) as { chunk_id: number }[]
  ).map((r) => r.chunk_id);
}

/** Forgets a source's position entirely, for starting it over. */
export function resetPosition(sourceId: number): void {
  tx(() => {
    db().prepare("DELETE FROM read_passages WHERE source_id=?").run(sourceId);
    db()
      .prepare(
        `UPDATE sources SET bookmark_chunk=NULL, bookmark_offset=NULL,
                progress=0, furthest_chunk=NULL WHERE id=?`
      )
      .run(sourceId);
  });
}

/** Moves the high-water mark forward, never back. */
function advanceFurthest(sourceId: number, chunkId: number, seq: number): void {
  const current = db()
    .prepare(
      `SELECT c.seq AS seq FROM chunks c
         JOIN sources s ON s.furthest_chunk = c.id
        WHERE s.id = ?`
    )
    .get(sourceId) as { seq: number } | undefined;

  if (current && current.seq >= seq) return;
  db().prepare("UPDATE sources SET furthest_chunk=? WHERE id=?").run(chunkId, sourceId);
}

/** The passage's place in this source, or null if it is not in this source. */
function seqOf(sourceId: number, chunkId: number): number | null {
  const row = db()
    .prepare("SELECT seq FROM chunks WHERE id=? AND source_id=?")
    .get(chunkId, sourceId) as { seq: number } | undefined;
  return row?.seq ?? null;
}

export interface ReadAlongResult {
  /** Passages handed to the model by this call. */
  queued: number;
  /** Passages of this source still unread by Corpus. */
  remaining: number;
  runId: number | null;
}

/**
 * Hands the model everything you have now read and it has not.
 *
 * Idempotent by construction: a chunk is queued only when it has neither been
 * extracted nor queued before, and `queued_at` is stamped in the same
 * transaction that enqueues it. Calling this on every scroll tick is therefore
 * safe, which matters because that is exactly what the reader does.
 */
export function readAlong(sourceId: number): ReadAlongResult {
  const source = db()
    .prepare(
      `SELECT s.id, s.read_mode,
              (SELECT COUNT(*) FROM chunks c WHERE c.source_id = s.id) AS chunks
         FROM sources s WHERE s.id = ?`
    )
    .get(sourceId) as { id: number; read_mode: string | null; chunks: number } | undefined;

  if (!source) return { queued: 0, remaining: 0, runId: null };

  const remaining = pendingCount(sourceId);
  if (readModeOf(source) !== "along") return { queued: 0, remaining, runId: null };

  // The furthest passage you have actually *read*, not merely scrolled past.
  //
  // Scroll position was the wrong signal here for the same reason it was the
  // wrong signal for progress: flicking to the end of a book would hand the
  // entire thing to the model at once, which is precisely what read-along
  // exists to prevent.
  const readSeq = (
    db()
      .prepare(
        `SELECT COALESCE(MAX(c.seq), -1) AS seq
           FROM read_passages r JOIN chunks c ON c.id = r.chunk_id
          WHERE r.source_id = ?`
      )
      .get(sourceId) as { seq: number }
  ).seq;

  if (readSeq < 0) return { queued: 0, remaining, runId: null };

  const due = db()
    .prepare(
      `SELECT id FROM chunks
        WHERE source_id = ? AND seq <= ?
          AND extracted_at IS NULL AND queued_at IS NULL AND skip_reason IS NULL
        ORDER BY seq`
    )
    .all(sourceId, readSeq + LOOKAHEAD) as { id: number }[];

  if (due.length === 0) return { queued: 0, remaining, runId: null };

  const runId = readingRun(sourceId);

  tx(() => {
    enqueue(
      runId,
      due.map((c) => ({ kind: "extract" as const, payload: { chunkId: c.id } }))
    );
    const stamp = db().prepare("UPDATE chunks SET queued_at=datetime('now') WHERE id=?");
    for (const c of due) stamp.run(c.id);

    // The tail — reconcile duplicates, then decide which entities have earned an
    // entry — has to stay at the end. Reading a book queues dozens of batches,
    // so rather than appending a fresh tail each time (and paying for a whole
    // resolution pass per scroll) the pending one is lifted and re-appended.
    dropPendingTail(runId);
    appendTail(runId, sourceId);

    db()
      .prepare("UPDATE sources SET status='extracting' WHERE id=? AND status='ready'")
      .run(sourceId);
  });

  // `remaining` counts passages Corpus has not *read*, which queueing does not
  // change — the work is now in flight, not done. Adding the batch to it here
  // reported a book as further behind the more of it had been handed over.
  return { queued: due.length, remaining, runId };
}

/**
 * Queues extraction for freshly written chunks, or doesn't.
 *
 * Every ingest path funnels through here so the read-along decision is made in
 * exactly one place. For an eager source this is the old behaviour: queue
 * everything, stamp it, get on with it. For a book, nothing is queued — the
 * chunks are left unstamped, which is precisely the state `readAlong` looks for
 * when you scroll past them.
 *
 * Caller supplies the transaction.
 */
export function queueExtractions(runId: number, sourceId: number, chunkIds: number[]): number {
  if (chunkIds.length === 0) return 0;

  const source = db()
    .prepare(
      `SELECT s.read_mode,
              (SELECT COUNT(*) FROM chunks c WHERE c.source_id = s.id) AS chunks
         FROM sources s WHERE s.id = ?`
    )
    .get(sourceId) as { read_mode: string | null; chunks: number } | undefined;

  // Only an eager source is read in bulk: "along" waits for you to get there,
  // and "shelf" is never read at all.
  if (!source || readModeOf(source) !== "eager") return 0;

  enqueue(
    runId,
    chunkIds.map((chunkId) => ({ kind: "extract" as const, payload: { chunkId } }))
  );
  const stamp = db().prepare("UPDATE chunks SET queued_at=datetime('now') WHERE id=?");
  for (const id of chunkIds) stamp.run(id);
  return chunkIds.length;
}

/**
 * Reads whatever of this source has never been read, now.
 *
 * The way back off the shelf, and the way a held article starts once you keep
 * it. Nothing is re-read: a passage that already has evidence, or is already
 * queued, or was skipped for a reason, is left exactly as it is.
 */
export function queueUnread(sourceId: number): { queued: number; runId: number | null } {
  const runId = readingRun(sourceId);
  const queued = tx(() => {
    const n = queueUnreadInto(runId, sourceId);
    if (n > 0) {
      dropPendingTail(runId);
      appendTail(runId, sourceId);
    }
    return n;
  });
  return queued > 0 ? { queued, runId } : { queued: 0, runId: null };
}

/**
 * The same, into a run the caller owns and closes.
 *
 * Separate because keeping ten articles from the inbox is one run with ten
 * sources in it, not ten runs — and one tail at the end of it rather than ten,
 * since resolution compares everything against everything and running it per
 * article would do the same work ten times. See lib/triage.ts.
 */
export function queueUnreadInto(runId: number, sourceId: number): number {
  // "Shelf" means never, and it means it here too: this is the function every
  // other way in eventually calls, so the guard belongs at the bottom rather
  // than repeated at each caller.
  const source = db()
    .prepare(
      `SELECT s.read_mode, (SELECT COUNT(*) FROM chunks c WHERE c.source_id = s.id) AS chunks
         FROM sources s WHERE s.id = ?`
    )
    .get(sourceId) as { read_mode: string | null; chunks: number } | undefined;
  if (!source || readModeOf(source) === "shelf") return 0;

  const due = (
    db()
      .prepare(
        `SELECT id FROM chunks
          WHERE source_id = ? AND extracted_at IS NULL AND queued_at IS NULL AND skip_reason IS NULL
          ORDER BY seq`
      )
      .all(sourceId) as { id: number }[]
  ).map((c) => c.id);
  if (!due.length) return 0;

  enqueue(
    runId,
    due.map((chunkId) => ({ kind: "extract" as const, payload: { chunkId } }))
  );
  const stamp = db().prepare("UPDATE chunks SET queued_at=datetime('now') WHERE id=?");
  for (const id of due) stamp.run(id);
  db().prepare("UPDATE sources SET status='extracting' WHERE id=?").run(sourceId);
  return due.length;
}

/** The reconciliation every reading ends with, for a caller that owns the run. */
export function appendReadingTail(runId: number, sourceId: number): void {
  appendTail(runId, sourceId);
}

/** Passages of this source the model has not read yet. */
export function pendingCount(sourceId: number): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM chunks
        WHERE source_id = ? AND extracted_at IS NULL AND skip_reason IS NULL`
    )
    .get(sourceId) as { n: number };
  return row.n;
}

/**
 * The one run per source that read-along work accumulates in.
 *
 * Reusing a run rather than creating one per batch keeps the Library legible —
 * "Reading along with Chomsky, 41 of 212" is a fact about the book, whereas
 * ninety two-task runs is a fact about the implementation.
 */
function readingRun(sourceId: number): number {
  const open = db()
    .prepare(
      `SELECT id FROM runs
        WHERE source_id = ? AND kind = 'readalong'
          AND state IN ('queued','running','paused_quota','paused_user','paused_budget','paused_key')
        ORDER BY id DESC LIMIT 1`
    )
    .get(sourceId) as { id: number } | undefined;
  if (open) return open.id;

  const title = (
    db().prepare("SELECT title FROM sources WHERE id=?").get(sourceId) as { title: string }
  ).title;

  return createRun({
    sourceId,
    kind: "readalong",
    label: `Reading along with ${title}`,
    budgetCap: getConfig().defaultBudget,
  });
}

const TAIL_KINDS = ["resolve", "sweep", "plan_context", "plan_entries"];

function dropPendingTail(runId: number): void {
  db()
    .prepare(
      `DELETE FROM tasks
        WHERE run_id = ? AND state = 'pending'
          AND kind IN (${TAIL_KINDS.map(() => "?").join(",")})`
    )
    .run(runId, ...TAIL_KINDS);
}

function appendTail(runId: number, sourceId: number): void {
  enqueue(
    runId,
    ENTITY_TYPES.map((type) => ({ kind: "resolve" as const, payload: { type } }))
  );
  // Costs nothing and finds most of the appearances extraction walks past.
  enqueue(runId, [{ kind: "sweep" as const, payload: { sourceId } }]);
  enqueue(runId, [{ kind: "plan_context" as const, payload: { sourceId } }]);
  enqueue(runId, [{ kind: "plan_entries" as const, payload: {} }]);
}
