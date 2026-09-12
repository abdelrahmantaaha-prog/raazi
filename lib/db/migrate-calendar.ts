import type Database from "better-sqlite3";

/**
 * The watching calendar.
 *
 * Extraction already records every dated happening a passage mentions — the
 * `events` table, one row per entity per date, with the source's own wording
 * beside a sortable form. What it never had was a place where those dates
 * could be read as dates rather than as facts about a person: an election
 * three weeks out, the anniversary of an attack, a ruling due "next month".
 *
 * This table is that place. A row is one event the brief has noticed, filed
 * under a bucket: a day when the source fixed one, and otherwise the week,
 * month or year the wording allows — "last week" against a piece published on
 * the 9th is the week of the 4th, and no more precise than that. Nothing here
 * is a model's judgement; every row points back at its event, its passage and
 * its source.
 */
export function migrateCalendar(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id    INTEGER NOT NULL UNIQUE REFERENCES events(id)   ON DELETE CASCADE,
      entity_id   INTEGER NOT NULL        REFERENCES entities(id) ON DELETE CASCADE,
      source_id   INTEGER                 REFERENCES sources(id)  ON DELETE CASCADE,
      mention_id  INTEGER                 REFERENCES mentions(id) ON DELETE SET NULL,
      -- day | week | month | year: how precisely the source fixed the date.
      kind        TEXT    NOT NULL,
      -- Sortable: YYYY-MM-DD for a day or a week's first day, YYYY-MM, YYYY.
      bucket      TEXT    NOT NULL,
      -- What the page prints: "14 Sep 2026", "Sometime in September 2026".
      label       TEXT    NOT NULL,
      date_text   TEXT,
      date_iso    TEXT,
      precision   TEXT,
      summary     TEXT    NOT NULL,
      -- Which brief noticed it: a day key, a week key, or 'refresh'.
      logged_from TEXT,
      logged_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      dismissed   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_bucket ON calendar(kind, bucket);
    CREATE INDEX IF NOT EXISTS idx_calendar_logged ON calendar(logged_from);
  `);
}
