import { db } from "./db";

/**
 * Literature review & news: what else has been written on something you are
 * reading or writing — research, papers and reports, and the news — found on
 * the open web by Claude on your plan, asked for by hand.
 *
 * Three ways in, one store: an article in the inbox (its source), a draft, or
 * a passage you highlighted in a source (the source, plus the passage as the
 * focus). Every review is kept, newest first, so the last one for a text is
 * there again when you come back to it. The work is done by the `litreview`
 * task in lib/pipeline/litreview.ts; nothing here touches a model.
 */

export type LitTarget = "draft" | "source";
export type LitKind = "paper" | "report" | "book" | "news" | "analysis";
export const LIT_KINDS: LitKind[] = ["paper", "report", "book", "news", "analysis"];
/** What counts as research rather than news, for the two lists the window shows. */
export const RESEARCH_KINDS: LitKind[] = ["paper", "report", "book"];

export interface LitResult {
  kind: LitKind;
  title: string;
  url: string;
  authors?: string;
  outlet?: string;
  date?: string;
  /** What it finds or reports, from the page. */
  finding: string;
  /** How it bears on the text: supports, contradicts, extends, background. */
  why: string;
  /** Set once you add it to the library. */
  sourceId?: number;
}

export interface LitReport {
  /** A short review of the field, citing the results as [1], [2]… in their order here. */
  overview: string;
  results: LitResult[];
  /** Results the answer named that no search returned — dropped, counted. */
  dropped: number;
  searchedAt: string;
  /** Said when only part of a long text was read. */
  partial?: string;
}

export type LitState = "running" | "waiting" | "done" | "failed";

export interface LitReview {
  id: number;
  target: LitTarget;
  target_id: number;
  focus: string | null;
  title: string;
  run_id: number | null;
  created_at: string;
  state: LitState;
  /** Why it failed, or why it is waiting. */
  note: string | null;
  report: LitReport | null;
}

interface Row {
  id: number;
  target: LitTarget;
  target_id: number;
  focus: string | null;
  context: string | null;
  title: string;
  run_id: number | null;
  report_json: string | null;
  created_at: string;
  run_state: string | null;
  run_error: string | null;
  task_state: string | null;
  task_error: string | null;
}

const SELECT = `
  SELECT l.*, r.state AS run_state, r.last_error AS run_error,
         (SELECT t.state FROM tasks t WHERE t.run_id = l.run_id AND t.kind = 'litreview' ORDER BY t.id DESC LIMIT 1) AS task_state,
         (SELECT t.last_error FROM tasks t WHERE t.run_id = l.run_id AND t.kind = 'litreview' ORDER BY t.id DESC LIMIT 1) AS task_error
    FROM lit_reviews l LEFT JOIN runs r ON r.id = l.run_id`;

function shape(row: Row): LitReview {
  let report: LitReport | null = null;
  if (row.report_json) {
    try {
      report = JSON.parse(row.report_json) as LitReport;
    } catch {
      /* unreadable: shown as failed below */
    }
  }
  let state: LitState = "running";
  let note: string | null = null;
  if (report) state = "done";
  else if (row.report_json || row.task_state === "failed" || row.task_state === "skipped" || row.run_state === "failed" || row.run_state === null) {
    state = "failed";
    note = row.task_error ?? row.run_error ?? "The search did not finish.";
  } else if (row.run_state?.startsWith("paused")) {
    state = "waiting";
    note =
      row.run_state === "paused_user"
        ? "Paused in Activity."
        : `Waiting for Claude to be free again${row.run_error ? ` — ${row.run_error}` : ""}.`;
  }
  return {
    id: row.id,
    target: row.target,
    target_id: row.target_id,
    focus: row.focus,
    title: row.title,
    run_id: row.run_id,
    created_at: row.created_at,
    state,
    note,
    report,
  };
}

export function getReview(id: number): LitReview | undefined {
  const row = db().prepare(`${SELECT} WHERE l.id = ?`).get(id) as Row | undefined;
  return row ? shape(row) : undefined;
}

/** The text behind a review, for the task. */
export function reviewInput(id: number): { target: LitTarget; target_id: number; focus: string | null; context: string | null; title: string } | undefined {
  return db().prepare("SELECT target, target_id, focus, context, title FROM lit_reviews WHERE id = ?").get(id) as
    | { target: LitTarget; target_id: number; focus: string | null; context: string | null; title: string }
    | undefined;
}

/** The reviews of one text, newest first. With a focus, only those of that passage. */
export function reviewsFor(target: LitTarget, targetId: number, focus?: string | null, limit = 10): LitReview[] {
  const rows = (
    focus === undefined
      ? db().prepare(`${SELECT} WHERE l.target = ? AND l.target_id = ? ORDER BY l.id DESC LIMIT ?`).all(target, targetId, limit)
      : db()
          .prepare(`${SELECT} WHERE l.target = ? AND l.target_id = ? AND l.focus IS ? ORDER BY l.id DESC LIMIT ?`)
          .all(target, targetId, focus, limit)
  ) as Row[];
  return rows.map(shape);
}

export function createReview(opts: {
  target: LitTarget;
  targetId: number;
  focus: string | null;
  context: string | null;
  title: string;
}): number {
  return Number(
    db()
      .prepare("INSERT INTO lit_reviews (target, target_id, focus, context, title) VALUES (?, ?, ?, ?, ?)")
      .run(opts.target, opts.targetId, opts.focus, opts.context, opts.title).lastInsertRowid
  );
}

export function setReviewRun(id: number, runId: number) {
  db().prepare("UPDATE lit_reviews SET run_id = ? WHERE id = ?").run(runId, id);
}

export function saveReport(id: number, report: LitReport) {
  db()
    .prepare("UPDATE lit_reviews SET report_json = ?, finished_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(report), id);
}

/** Marks one result as added to the library. */
export function markAdded(id: number, index: number, sourceId: number): LitReview | undefined {
  const review = getReview(id);
  const result = review?.report?.results[index];
  if (!review?.report || !result) return review;
  result.sourceId = sourceId;
  saveReport(id, review.report);
  return getReview(id);
}

/**
 * The overview with its citations renumbered to the results that were kept.
 *
 * The model cites results by their place in its own list; a result it named
 * but never read is dropped, which moves every number after it. A citation of
 * a dropped result is removed rather than left pointing at the wrong one.
 * Pure. `kept[n]` is the original 1-based number of the result now at n+1.
 */
export function renumberCitations(overview: string, kept: number[]): string {
  const to = new Map(kept.map((old, i) => [old, i + 1]));
  return overview
    .replace(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g, (_, list: string) => {
      const nums: number[] = [];
      for (const part of list.split(/\s*,\s*/)) {
        const range = /^(\d+)\s*[–-]\s*(\d+)$/.exec(part);
        if (range) for (let n = Number(range[1]); n <= Number(range[2]) && n - Number(range[1]) < 50; n++) nums.push(n);
        else nums.push(Number(part));
      }
      const mapped = [...new Set(nums.map((n) => to.get(n)).filter((n): n is number => n !== undefined))];
      return mapped.length ? `[${mapped.join(", ")}]` : "";
    })
    .replace(/ +([.,;:])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}
