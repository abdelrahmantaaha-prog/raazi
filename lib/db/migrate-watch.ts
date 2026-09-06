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
  //
  // Keyed by kind as well as id because the promotion pass moved from entities
  // to topics within a day of being written: entity watches repeated
  // themselves — one article about the president landed under Donald Trump,
  // the Trump administration, the White House and the United States — and a
  // topic says once what four entities said four times.
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_dismissed (
      kind         TEXT    NOT NULL,   -- 'entity' | 'topic'
      ref_id       INTEGER NOT NULL,
      dismissed_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (kind, ref_id)
    );
  `);

  // The first shape of the same idea, entity-only, lived for one day. Anything
  // refused while it existed is still a refusal.
  const old = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='watch_declined'")
    .get();
  if (old) {
    db.exec(`
      INSERT OR IGNORE INTO watch_dismissed (kind, ref_id, dismissed_at)
        SELECT 'entity', entity_id, declined_at FROM watch_declined;
      DROP TABLE watch_declined;
    `);
    console.log("[corpus] migrated: watch_declined → watch_dismissed");
  }
}
