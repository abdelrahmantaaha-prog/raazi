import type Database from "better-sqlite3";

/**
 * Inbox bundles: the level above stories.
 *
 * A story is one event with several accounts, and grouping by story can
 * only ever fold duplicates: five hundred items that are five hundred
 * different things stay five hundred rows. What lets a reporter clear an
 * inbox is the level above — the subject a morning's items fall into,
 * "AI regulation", "Iran war costs", "Quebec election" — where a whole
 * bundle can be kept, filed or discarded in one decision.
 *
 * Bundles are an inbox thing, not a library thing: they say nothing about
 * the sources, only how the items waiting for a decision are arranged. They
 * are rebuilt by the grouping pass, which is told the labels already in use
 * so they stay put from one morning to the next. An item is in one bundle
 * or none; a decided item is no longer in any.
 */
export function migrateBundles(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_bundles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      label       TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS inbox_bundle_items (
      item_id     INTEGER PRIMARY KEY REFERENCES feed_items(id) ON DELETE CASCADE,
      bundle_id   INTEGER NOT NULL REFERENCES inbox_bundles(id) ON DELETE CASCADE,
      assigned_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bundle_items_bundle ON inbox_bundle_items(bundle_id);
  `);
}
