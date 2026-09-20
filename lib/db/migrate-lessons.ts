import type Database from "better-sqlite3";
import { SEED_LESSONS } from "../lessons-seed";

/**
 * Lessons: the app's own memory of how its writing goes wrong.
 *
 * Every model call carries a system prompt written into the code, and the
 * code is where the rules have lived. That has two costs. A rule only
 * changes when someone edits a prompt and rebuilds, so a correction you
 * make in your head on a Tuesday morning is not one the writer has by
 * Wednesday. And the rules are invisible: the researcher who reads a bad
 * entry cannot see what the writer was told, or tell it anything.
 *
 * A lesson is one short standing instruction, scoped to a stage — the entry
 * writer, the brief, extraction, the verifier, filing — or to all of them.
 * Every call for that stage gets the lessons appended to its system prompt,
 * newest first, within a bound. You add one from Settings in your own
 * words; the app ships with the ones learned from its own audits, and you
 * can switch any of them off.
 *
 * `key` is set on the shipped ones so seeding is idempotent and your edits
 * to them survive an upgrade; yours have none.
 */
export function migrateLessons(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lessons (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      -- 'all' or a stage: extract | resolve | entry | verify | tag | brief
      stage       TEXT    NOT NULL DEFAULT 'all',
      text        TEXT    NOT NULL,
      -- What went wrong that taught it, for the reader rather than the model.
      why         TEXT,
      -- user | seed | app
      source      TEXT    NOT NULL DEFAULT 'user',
      key         TEXT    UNIQUE,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lessons_stage ON lessons(stage, active);
  `);

  const insert = db.prepare(
    "INSERT OR IGNORE INTO lessons (stage, text, why, source, key) VALUES (?, ?, ?, 'seed', ?)"
  );
  let added = 0;
  for (const s of SEED_LESSONS) added += insert.run(s.stage, s.text, s.why ?? null, s.key).changes;
  if (added > 0) console.log(`[corpus] lessons: ${added} shipped lesson(s) added`);
}
