-- Raazi schema. Applied idempotently on every boot (see lib/db/index.ts).
-- Everything here is local; there is no multi-user concern and no migration story
-- beyond "add columns with ALTER TABLE in migrations.ts".

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Tags — the research topics you are working on
-- ---------------------------------------------------------------------------

-- Tags organise without partitioning. An entity is never split or duplicated by
-- topic: one person stays one person, carrying however many tags apply, and you
-- filter by them.
CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  description TEXT,
  color       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- A source can serve more than one topic.
CREATE TABLE IF NOT EXISTS source_tags (
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
  assigned  TEXT    NOT NULL DEFAULT 'user',   -- user | ai
  PRIMARY KEY (source_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_source_tags_tag ON source_tags(tag_id);

-- An entity's tags are mostly *derived*: it carries whatever tags the sources
-- that mention it carry, recomputed live so it is never stale. This table holds
-- only your overrides on top — a tag you added by hand, or a derived one you
-- want hidden for this entity.
CREATE TABLE IF NOT EXISTS entity_tags (
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
  state     TEXT    NOT NULL DEFAULT 'added',   -- added | hidden
  PRIMARY KEY (entity_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(tag_id);

-- ---------------------------------------------------------------------------
-- Sources and their text
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  author      TEXT,
  kind        TEXT    NOT NULL,          -- pdf | epub | text | url | media
  path        TEXT,                      -- data/sources/<id>.<ext>, for uploaded files
  url         TEXT,                      -- for url + youtube sources
  year        TEXT,
  publisher   TEXT,
  lang        TEXT,
  status      TEXT    NOT NULL DEFAULT 'new',  -- new | chunked | extracting | ready | failed
  note        TEXT,
  meta_json   TEXT    NOT NULL DEFAULT '{}',
  added_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- A document is a subdivision of a source: a chapter, a page range, a transcript.
-- Its label is what a citation shows.
CREATE TABLE IF NOT EXISTS documents (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ordinal   INTEGER NOT NULL,
  label     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id, ordinal);

CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  doc_id       INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  seq          INTEGER NOT NULL,
  text         TEXT    NOT NULL,
  token_est    INTEGER NOT NULL DEFAULT 0,
  -- {page?, chapter?, timecode?, charStart, charEnd}
  locator_json TEXT    NOT NULL DEFAULT '{}',
  -- extraction bookkeeping, so a re-run knows what it already did
  extracted_at TEXT,
  skip_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id, seq);

-- ---------------------------------------------------------------------------
-- The pedia: entities, the evidence for them, and what connects them
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT    NOT NULL,   -- person|org|institution|event|place|work|concept
  canonical_name TEXT    NOT NULL,
  normalized     TEXT    NOT NULL,   -- match key, see lib/normalize.ts
  disambiguator  TEXT,               -- "Egyptian president" — keeps two Nassers apart
  lang           TEXT,
  starred        INTEGER NOT NULL DEFAULT 0,
  -- none: never generated. fresh: matches evidence. stale: new evidence arrived.
  entry_state    TEXT    NOT NULL DEFAULT 'none',
  embedding      BLOB,               -- Float32Array of the name+disambiguator
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  merged_into    INTEGER REFERENCES entities(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_norm  ON entities(type, normalized);
CREATE INDEX IF NOT EXISTS idx_entities_state ON entities(entry_state);

CREATE TABLE IF NOT EXISTS aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id  INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  surface    TEXT    NOT NULL,
  normalized TEXT    NOT NULL,
  UNIQUE(entity_id, normalized)
);
CREATE INDEX IF NOT EXISTS idx_aliases_norm ON aliases(normalized);

-- One row per time an entity appears in a chunk. This is the evidence base:
-- every sentence of every entry must trace back to one of these.
CREATE TABLE IF NOT EXISTS mentions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id  INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  chunk_id   INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  surface    TEXT    NOT NULL,
  quote      TEXT    NOT NULL,   -- verbatim sentence(s) from the chunk
  claim      TEXT,               -- what this passage asserts about the entity
  starred    INTEGER NOT NULL DEFAULT 0,
  confidence REAL    NOT NULL DEFAULT 1.0
);
CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions(entity_id);
CREATE INDEX IF NOT EXISTS idx_mentions_chunk  ON mentions(chunk_id);
CREATE INDEX IF NOT EXISTS idx_mentions_star   ON mentions(starred);
-- Per-source counts run on the Library poll, and re-extraction deletes by
-- source; without this both were full scans of the table.
CREATE INDEX IF NOT EXISTS idx_mentions_source ON mentions(source_id);

CREATE TABLE IF NOT EXISTS relations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_entity INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL,   -- "founded", "worked for", "met with", ...
  source_id   INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  mention_id  INTEGER REFERENCES mentions(id) ON DELETE SET NULL,
  quote       TEXT
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity);
CREATE INDEX IF NOT EXISTS idx_relations_to   ON relations(to_entity);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id  INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  date_text  TEXT,               -- as written in the source: "spring of 1956"
  date_iso   TEXT,               -- best-effort sortable: "1956-03"
  precision  TEXT,               -- day | month | year | decade | unknown
  summary    TEXT    NOT NULL,
  source_id  INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  mention_id INTEGER REFERENCES mentions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_id, date_iso);

-- ---------------------------------------------------------------------------
-- Entries: derived from mentions, never authored once
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entries (
  entity_id       INTEGER PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  summary         TEXT NOT NULL DEFAULT '',
  body_md         TEXT NOT NULL DEFAULT '',
  -- hash of the mention-id set this body was built from. Mismatch => stale.
  built_from_hash TEXT NOT NULL DEFAULT '',
  model           TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entry_revisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id         INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  body_md           TEXT NOT NULL,
  changelog_md      TEXT,              -- what this revision changed, and why
  trigger_source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_revisions_entity ON entry_revisions(entity_id, created_at);

-- Sources disagreeing is a finding, not an error. Both sides are kept.
CREATE TABLE IF NOT EXISTS contradictions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id  INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  claim_a    TEXT NOT NULL,
  claim_b    TEXT NOT NULL,
  source_a   INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  source_b   INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  quote_a    TEXT,
  quote_b    TEXT,
  resolved   INTEGER NOT NULL DEFAULT 0,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contradictions_entity ON contradictions(entity_id, resolved);

-- Every merge decision, so they are reversible and never re-adjudicated.
CREATE TABLE IF NOT EXISTS merge_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kept_entity   INTEGER NOT NULL,
  merged_entity INTEGER NOT NULL,
  kept_name     TEXT,
  merged_name   TEXT,
  reason        TEXT,
  actor         TEXT NOT NULL DEFAULT 'auto',  -- auto | user
  undone        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pairs already judged "different" so the adjudicator is never asked twice.
CREATE TABLE IF NOT EXISTS resolution_verdicts (
  a_norm   TEXT NOT NULL,
  b_norm   TEXT NOT NULL,
  type     TEXT NOT NULL,
  same     INTEGER NOT NULL,
  PRIMARY KEY (type, a_norm, b_norm)
);

-- ---------------------------------------------------------------------------
-- Durable job queue — the thing that makes ingestion resumable
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id  INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,   -- ingest | entry | reextract
  label      TEXT,
  -- queued|running|paused_quota|paused_user|paused_budget|paused_key|done|failed
  state      TEXT    NOT NULL DEFAULT 'queued',
  resume_at  TEXT,               -- ISO time this run may retry on its own
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  budget_cap INTEGER,            -- total tokens; worker parks the run at the cap
  last_error TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  kind         TEXT    NOT NULL,   -- extract | ocr | resolve | entry | transcribe
  payload_json TEXT    NOT NULL DEFAULT '{}',
  -- pending | running | done | failed | skipped | superseded
  state        TEXT    NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_claim ON tasks(run_id, state, seq);

-- ---------------------------------------------------------------------------
-- Full-text search over both the raw text and the written entries
-- ---------------------------------------------------------------------------

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  summary,
  body_md,
  content='entries',
  content_rowid='entity_id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, summary, body_md)
  VALUES (new.entity_id, new.summary, new.body_md);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, summary, body_md)
  VALUES ('delete', old.entity_id, old.summary, old.body_md);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, summary, body_md)
  VALUES ('delete', old.entity_id, old.summary, old.body_md);
  INSERT INTO entries_fts(rowid, summary, body_md)
  VALUES (new.entity_id, new.summary, new.body_md);
END;
