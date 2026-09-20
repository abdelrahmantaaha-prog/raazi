import type Database from "better-sqlite3";

/**
 * A book and its translation, and the correspondence between them.
 *
 * A translation is an ordinary source — it is ingested, chunked and read like
 * any other, and can be cited on its own. What makes it a translation is one
 * column pointing at the book it renders, and a table of which passage
 * answers to which.
 *
 * The correspondence is stored rather than computed on the fly because
 * aligning a book is a second of work and reading one is a morning of it, and
 * because a pair you corrected by hand has to outlive the next page turn.
 *
 * A pair may hold several chunks on either side, or none on one: translators
 * join two paragraphs into one, split one into three, and leave things out.
 * That is what the bead model in lib/align/script.ts produces, and the shape
 * here follows it rather than pretending every paragraph has a partner.
 */
export function migrateTranslations(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(sources)").all() as { name: string }[];
  if (cols.length && !cols.some((c) => c.name === "translation_of")) {
    db.exec("ALTER TABLE sources ADD COLUMN translation_of INTEGER REFERENCES sources(id) ON DELETE SET NULL");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS alignments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      original_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      translation_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      -- Reading order down the original.
      seq            INTEGER NOT NULL,
      -- JSON arrays of chunk ids. Either may be empty: a passage the
      -- translator left out, or one they added.
      o_chunks       TEXT NOT NULL DEFAULT '[]',
      t_chunks       TEXT NOT NULL DEFAULT '[]',
      confidence     REAL NOT NULL DEFAULT 0,
      -- anchor | length | model | hand
      via            TEXT NOT NULL DEFAULT 'length',
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS alignments_pair ON alignments(original_id, translation_id, seq);
    CREATE INDEX IF NOT EXISTS alignments_translation ON alignments(translation_id);
    CREATE INDEX IF NOT EXISTS sources_translation_of ON sources(translation_of);
  `);
}
