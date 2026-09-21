import type Database from "better-sqlite3";

/**
 * A vector per passage, so a vague question can find the passage that answers
 * it without either of them sharing a word.
 *
 * Kept in its own table rather than a column on `chunks` because the vectors
 * are the one part of this database that is disposable: they are derived, they
 * are large next to the text, and a change of embedding model invalidates all
 * of them at once. `model` and `dim` are on the row so a mixed set can be
 * spotted and rebuilt rather than silently compared against each other, which
 * would return nonsense ranked confidently.
 */
export function migrateVectors(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_vectors (
      chunk_id   INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      vec        BLOB NOT NULL,
      model      TEXT NOT NULL,
      dim        INTEGER NOT NULL,
      -- The text this vector was made from, so a re-read that rewrites the
      -- passage is noticed rather than leaving a vector describing the old one.
      hash       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS chunk_vectors_source ON chunk_vectors(source_id);
  `);
}
