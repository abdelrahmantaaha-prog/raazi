import { db } from "./db";
import { STAGES, type Stage } from "./providers";

/**
 * What the models have been told to stop doing. See lib/db/migrate-lessons.ts
 * for what a lesson is and why it lives in the database rather than the code.
 *
 * The block a call receives is bounded on purpose. A prompt that grows by one
 * line every time something goes wrong is a prompt that, a year on, is mostly
 * lessons; the model reads the first few and skims the rest, and the newest
 * one — the one you just added because of this morning's brief — is at the
 * bottom. So: yours before the shipped ones, newest first, and a cap on both
 * the count and the characters. Beyond the cap the rest are simply not sent,
 * and Settings says so.
 */

export interface Lesson {
  id: number;
  stage: string;
  text: string;
  why: string | null;
  source: "user" | "seed" | "app";
  key: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

/** The most lessons one stage is given, its own and the ones for every stage together. */
export const MAX_LESSONS_PER_CALL = 16;
/** And the most characters, since a lesson can be a paragraph. */
export const MAX_LESSON_CHARS = 2600;

export const LESSON_STAGES: string[] = ["all", ...STAGES];

export function isLessonStage(s: unknown): s is string {
  return typeof s === "string" && LESSON_STAGES.includes(s);
}

export function listLessons(): Lesson[] {
  return db()
    .prepare(
      `SELECT * FROM lessons
        ORDER BY CASE source WHEN 'user' THEN 0 WHEN 'app' THEN 1 ELSE 2 END, id DESC`
    )
    .all() as Lesson[];
}

export function addLesson(opts: { stage: string; text: string; why?: string | null; source?: "user" | "app" }): Lesson {
  const stage = isLessonStage(opts.stage) ? opts.stage : "all";
  const text = opts.text.replace(/\s+/g, " ").trim();
  if (!text) throw new Error("A lesson needs words.");
  const id = Number(
    db()
      .prepare("INSERT INTO lessons (stage, text, why, source) VALUES (?, ?, ?, ?)")
      .run(stage, text.slice(0, 1200), opts.why?.trim().slice(0, 600) || null, opts.source ?? "user").lastInsertRowid
  );
  return db().prepare("SELECT * FROM lessons WHERE id=?").get(id) as Lesson;
}

export function updateLesson(id: number, patch: { text?: string; why?: string | null; stage?: string; active?: boolean }): boolean {
  const row = db().prepare("SELECT * FROM lessons WHERE id=?").get(id) as Lesson | undefined;
  if (!row) return false;
  const text = patch.text !== undefined ? patch.text.replace(/\s+/g, " ").trim().slice(0, 1200) : row.text;
  if (!text) throw new Error("A lesson needs words.");
  db()
    .prepare("UPDATE lessons SET text=?, why=?, stage=?, active=?, updated_at=datetime('now') WHERE id=?")
    .run(
      text,
      patch.why !== undefined ? patch.why?.trim().slice(0, 600) || null : row.why,
      patch.stage !== undefined && isLessonStage(patch.stage) ? patch.stage : row.stage,
      patch.active !== undefined ? (patch.active ? 1 : 0) : row.active,
      id
    );
  return true;
}

/** Removes a lesson. A shipped one comes back switched off if it is ever re-seeded, not on. */
export function removeLesson(id: number): boolean {
  const row = db().prepare("SELECT key FROM lessons WHERE id=?").get(id) as { key: string | null } | undefined;
  if (!row) return false;
  if (row.key) {
    // Keep the row so the seed does not restore it on the next start; a
    // lesson you removed is a decision, and "off" is how it is remembered.
    db().prepare("UPDATE lessons SET active=0, updated_at=datetime('now') WHERE id=?").run(id);
    return true;
  }
  return db().prepare("DELETE FROM lessons WHERE id=?").run(id).changes > 0;
}

/** The lessons a call for this stage would be given, in the order it gets them. */
export function lessonsFor(stage: Stage | string | undefined): Lesson[] {
  if (!stage) return [];
  const rows = db()
    .prepare(
      `SELECT * FROM lessons
        WHERE active = 1 AND (stage = ? OR stage = 'all')
        ORDER BY CASE source WHEN 'user' THEN 0 WHEN 'app' THEN 1 ELSE 2 END,
                 CASE WHEN stage = 'all' THEN 1 ELSE 0 END, id DESC`
    )
    .all(stage) as Lesson[];
  const out: Lesson[] = [];
  let chars = 0;
  for (const r of rows) {
    if (out.length >= MAX_LESSONS_PER_CALL) break;
    if (chars + r.text.length > MAX_LESSON_CHARS && out.length > 0) break;
    out.push(r);
    chars += r.text.length;
  }
  return out;
}

/** How many of a stage's active lessons are past the cap and so not sent. */
export function lessonsHeldBack(stage: string): number {
  const active = (
    db()
      .prepare("SELECT COUNT(*) AS n FROM lessons WHERE active = 1 AND (stage = ? OR stage = 'all')")
      .get(stage) as { n: number }
  ).n;
  return Math.max(0, active - lessonsFor(stage).length);
}

/** The block as the model reads it, or "" when there is nothing to say. */
export function lessonsBlock(stage: Stage | string | undefined): string {
  const rows = lessonsFor(stage);
  if (!rows.length) return "";
  return (
    `LESSONS. What earlier work on this task got wrong, in the researcher's words. Each is a standing instruction and outranks your own habit:\n` +
    rows.map((r) => `- ${r.text}`).join("\n")
  );
}

/**
 * A system prompt with the stage's lessons appended. Never throws: a call
 * that could not read its lessons still goes out, with the prompt it had.
 */
export function withLessons(system: string | undefined, stage: Stage | string | undefined): string | undefined {
  try {
    const block = lessonsBlock(stage);
    if (!block) return system;
    return system ? `${system}\n\n${block}` : block;
  } catch {
    return system;
  }
}
