import type Database from "better-sqlite3";

/**
 * The watchlist learns from what you keep.
 *
 * Two columns' worth of bookkeeping, kept in its own file because everything
 * it supports arrived together on 2026-09-06.
 */
export function migrateWatch(db: Database.Database) {
  const has = (table: string, column: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

  // Who put this on the list. 'user' is you, and nothing ever removes it;
  // 'auto' is the promotion pass, which is also the only thing allowed to
  // tidy up after itself.
  if (!has("watchlist", "source")) {
    db.exec(`ALTER TABLE watchlist ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`);
    console.log("[corpus] migrated: watchlist.source");
  }

  // What you took off the list after the app suggested it.
  //
  // Without this the promotion pass is a nuisance rather than a feature: it
  // would re-add tomorrow exactly what you removed today, and keep doing it
  // for as long as the subject stayed in the news — which is precisely as
  // long as it takes to become infuriating. A subject you declined is
  // declined; watch it by hand and the star overrides this.
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_declined (
      entity_id   INTEGER PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
      declined_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
