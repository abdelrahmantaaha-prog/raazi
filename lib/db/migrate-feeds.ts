import type Database from "better-sqlite3";

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (c) => c.name === column
  );
}

function addColumn(db: Database.Database, table: string, column: string, ddl: string) {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  console.log(`[corpus] migrated: ${table}.${column}`);
}

/**
 * The aggregator: feeds, the items they carry, the stories those items belong
 * to, what you are watching, and the daily brief.
 *
 * Kept apart from the shared migrations because it is a layer rather than a
 * repair — everything here was added on 2026-09-03 when the pedia became a
 * newsroom tool, and none of it changes how an existing library behaves until
 * a feed is added.
 */
export function migrateFeeds(db: Database.Database) {
  db.exec(`
    -- A place that publishes. One row per feed you follow: an RSS or Atom
    -- file, a YouTube channel, a Google News query, or a page watched for
    -- changes. Everything the poller needs to be a good citizen — the etag,
    -- the interval, the daily cap — lives on the row rather than in config,
    -- because a wire service and a think tank deserve different manners.
    CREATE TABLE IF NOT EXISTS feeds (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      url              TEXT    NOT NULL UNIQUE,
      title            TEXT    NOT NULL,
      outlet           TEXT,
      -- rss | atom | youtube | page. Set when the feed is added, from what
      -- the fetch actually returned rather than from the URL's shape.
      kind             TEXT    NOT NULL DEFAULT 'rss',
      -- Your own note on how far to trust it. Shown beside every citation
      -- drawn from it, and given to the entry writer.
      reliability      TEXT,
      enabled          INTEGER NOT NULL DEFAULT 1,
      interval_minutes INTEGER NOT NULL DEFAULT 60,
      -- The most items this feed may turn into sources in one day. A feed
      -- that suddenly republishes its whole archive is the failure this
      -- prevents, and it costs tokens per item.
      daily_cap        INTEGER NOT NULL DEFAULT 40,
      -- Only items published after this are ingested, so adding a feed does
      -- not read its entire back catalogue.
      since            TEXT,
      last_polled_at   TEXT,
      last_status      TEXT,
      etag             TEXT,
      last_modified    TEXT,
      added_at         TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Topics a feed's items are filed under automatically, so a beat feed
    -- does not need the model to guess what it is about.
    CREATE TABLE IF NOT EXISTS feed_tags (
      feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
      PRIMARY KEY (feed_id, tag_id)
    );

    -- Everything a feed has offered, whether or not it was ingested.
    --
    -- The row exists before the source does, and survives the source being
    -- deleted, which is what stops a story you threw out from coming back on
    -- the next poll. The state column says what happened to it, and note why.
    CREATE TABLE IF NOT EXISTS feed_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id       INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid          TEXT    NOT NULL,
      url           TEXT,
      canonical_url TEXT,
      title         TEXT,
      summary       TEXT,
      published_at  TEXT,
      seen_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      source_id     INTEGER REFERENCES sources(id) ON DELETE SET NULL,
      -- new | queued | ready | duplicate | skipped | failed
      state         TEXT    NOT NULL DEFAULT 'new',
      note          TEXT,
      UNIQUE (feed_id, guid)
    );
    CREATE INDEX IF NOT EXISTS idx_feed_items_state ON feed_items(state, published_at);
    CREATE INDEX IF NOT EXISTS idx_feed_items_canon ON feed_items(canonical_url);

    -- One running story, carrying however many accounts of it.
    --
    -- Six outlets on one wire report is six sources and one story, and the
    -- brief is unreadable if it is not told the difference. Grouping is by
    -- headline similarity and shared entities inside a window; you can rename
    -- a story, pin it, or split a source out by hand.
    CREATE TABLE IF NOT EXISTS stories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL,
      -- Fingerprint of the headline that opened the story, for matching.
      shingle     TEXT    NOT NULL DEFAULT '',
      pinned      INTEGER NOT NULL DEFAULT 0,
      named_by    TEXT    NOT NULL DEFAULT 'auto',   -- auto | user
      first_seen  TEXT    NOT NULL DEFAULT (datetime('now')),
      last_seen   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS story_sources (
      story_id  INTEGER NOT NULL REFERENCES stories(id)  ON DELETE CASCADE,
      source_id INTEGER NOT NULL REFERENCES sources(id)  ON DELETE CASCADE,
      -- Why this account was filed here, so a wrong grouping is explicable.
      reason    TEXT,
      PRIMARY KEY (story_id, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_story_sources_source ON story_sources(source_id);

    -- What you are following. An entity, a topic, or a phrase; the brief is
    -- built around these and a new source touching one is flagged.
    CREATE TABLE IF NOT EXISTS watchlist (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER REFERENCES entities(id) ON DELETE CASCADE,
      tag_id    INTEGER REFERENCES tags(id)     ON DELETE CASCADE,
      phrase    TEXT,
      note      TEXT,
      added_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_watch_entity ON watchlist(entity_id) WHERE entity_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_watch_tag    ON watchlist(tag_id)    WHERE tag_id IS NOT NULL;

    -- One brief per day. The body is written from the database rather than
    -- from the articles, so every line in it carries a citation that resolves
    -- in the pedia like any other.
    CREATE TABLE IF NOT EXISTS briefs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      day         TEXT    NOT NULL UNIQUE,
      body_md     TEXT    NOT NULL DEFAULT '',
      state       TEXT    NOT NULL DEFAULT 'pending',   -- pending | done | failed
      window_from TEXT,
      window_to   TEXT,
      stats_json  TEXT    NOT NULL DEFAULT '{}',
      tokens_in   INTEGER NOT NULL DEFAULT 0,
      tokens_out  INTEGER NOT NULL DEFAULT 0,
      error       TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // --- Review before reading (2026-09-05) ------------------------------------
  //
  // A feed used to pull an article and hand it straight to the extractor. That
  // is the right shape for a library you chose book by book and the wrong one
  // for a beat: most of what a wire feed carries is not your story, and paying
  // to read it is paying to be told so. So an article now arrives, is fetched
  // and chunked — both free — and then waits. Nothing costs a token until you
  // say the piece is worth reading.

  // When you decided about this item, so an inbox can show what is still open
  // and a week can be built from what you actually kept.
  addColumn(db, "feed_items", "decided_at", "TEXT");

  // The decision, on the source rather than only on the feed item, because
  // everything downstream — the library, the brief, the stories — reads
  // sources. NULL means "not from a feed, or from before this existed", and
  // those behave exactly as they always did.
  //   held      fetched and chunked, waiting for you
  //   kept      you said yes; the reading pipeline has it
  //   discarded you said no; it stays only so the address is still recognised
  addColumn(db, "sources", "triage", "TEXT");

  // When you said yes. The weekly brief runs on this rather than on when the
  // piece was published: an article from Sunday that you kept on Monday is
  // Monday's work, which is how you will remember it and where you will look
  // for it. NULL for everything that never went through an inbox.
  addColumn(db, "sources", "kept_at", "TEXT");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_triage ON sources(triage) WHERE triage IS NOT NULL;`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_feed_items_state ON feed_items(state);`);

  // A brief is now either a day's or a week's. The key stays in `day` — a
  // week's is its Friday, prefixed — so the UNIQUE constraint still holds and
  // no table has to be rebuilt.
  addColumn(db, "briefs", "kind", "TEXT NOT NULL DEFAULT 'day'");

  // Which model wrote the brief, as the provider reported it. NULL when the
  // brief was the "nothing came in" notice, which no model writes.
  addColumn(db, "briefs", "model", "TEXT");

  // When an entry was last rewritten to chase verification flags. See
  // flaggedForRewrite(): the rewrite counter beside it resets whenever the
  // evidence changes, so on a daily beat it never reached its cap.
  addColumn(db, "entries", "flag_rewritten_at", "TEXT");
}
