import type Database from "better-sqlite3";
import { isJunkText } from "../junk-text";

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

  // Passages that are not text had vectors made for them before anything
  // checked — 183 of them on 22 September 2026, nearly all one PDF read as
  // bytes. The vector goes and the row stays, as dim 0, so the passage is
  // neither searched nor offered to the indexer again. Runs over vectors
  // that still have a dimension, so once they are marked it finds nothing.
  const rows = db
    .prepare(
      `SELECT v.chunk_id AS id, c.text FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk_id WHERE v.dim > 0`
    )
    .all() as { id: number; text: string }[];
  const junk = rows.filter((r) => isJunkText(r.text));
  if (junk.length) {
    const mark = db.prepare("UPDATE chunk_vectors SET vec = ?, dim = 0 WHERE chunk_id = ?");
    const empty = Buffer.alloc(0);
    db.transaction(() => {
      for (const r of junk) mark.run(empty, r.id);
    })();
    console.log(`[corpus] set aside ${junk.length} passage vector(s) that were not text`);
  }
}
