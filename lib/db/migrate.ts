import type Database from "better-sqlite3";
import { migrateQueue, supersedeDuplicateEntries } from "./migrate-queue";
import { migrateFeeds } from "./migrate-feeds";
import { migrateWatch } from "./migrate-watch";
import { migrateCalendar } from "./migrate-calendar";
import { migrateLessons } from "./migrate-lessons";
import { migrateEscapes } from "./migrate-escapes";
import { migrateCitations } from "./migrate-citations";
import { migrateTranslations } from "./migrate-translations";
import { migrateVectors } from "./migrate-vectors";
import { migrateBundles } from "./migrate-bundles";

/**
 * `schema.sql` is all CREATE IF NOT EXISTS, which means it can add tables to an
 * existing library but never columns. Anything added to a table after the first
 * release goes here instead, guarded so it is safe to run on every boot.
 */

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function addColumn(db: Database.Database, table: string, column: string, ddl: string) {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  console.log(`[corpus] migrated: ${table}.${column}`);
}

export function migrate(db: Database.Database) {
  // Whether a source has been through AI tagging yet, so the Library can offer
  // to file the ones that haven't without re-asking about the rest.
  addColumn(db, "sources", "tagged_at", "TEXT");

  // Where you stopped reading. Kept with the source rather than in the browser
  // so it survives a cleared cache and shows on the shelf.
  addColumn(db, "sources", "bookmark_chunk", "INTEGER");
  addColumn(db, "sources", "bookmark_offset", "REAL");
  addColumn(db, "sources", "read_at", "TEXT");

  // The folder a source was read from, when it came in a zip or a folder.
  addColumn(db, "sources", "folder_id", "INTEGER");

  // "Do this first" on a batch in Activity: its reading goes ahead of the rest.
  addColumn(db, "runs", "first", "INTEGER NOT NULL DEFAULT 0");

  // Your own answer to "what kind of thing is this", overriding the guess made
  // from file type and length. Null means "keep guessing".
  addColumn(db, "sources", "shelf", "TEXT");

  // How far through you are, 0..1, and the furthest chunk you have reached.
  //
  // The reader used to derive this from scroll position alone, which meant it
  // existed only while the reader was open and was zero everywhere else. Read
  // progress is a property of the book, not of a scroll container, so it is
  // stored — the shelf shows it, and read-along extraction depends on it.
  addColumn(db, "sources", "progress", "REAL NOT NULL DEFAULT 0");
  addColumn(db, "sources", "furthest_chunk", "INTEGER");

  // 'eager' reads the whole source the moment it is added; 'along' reads only
  // what you have actually read, a passage at a time. See lib/reading.ts.
  addColumn(db, "sources", "read_mode", "TEXT");

  // Your own answer to "have I read this", overriding what progress implies.
  // Null means "work it out from how much I have read". See lib/shelves.ts.
  addColumn(db, "sources", "reading_state", "TEXT");

  // When a chunk was handed to the model. Distinct from extracted_at, which is
  // when it came back: read-along is called on every scroll tick and needs to
  // know a passage is already in flight, or it would queue it again each time.
  addColumn(db, "chunks", "queued_at", "TEXT");

  // What a quote leans on to make sense.
  //
  // Sources refer back constantly — "following one incident", "the agreement",
  // "he" — and a quote lifted out of its paragraph loses the referent. The
  // extractor is now shown the preceding text and asked to name what such a
  // phrase points at, and that resolution is stored beside the quote rather
  // than thrown away, because the entry writer needs it just as badly.
  addColumn(db, "mentions", "context", "TEXT");
  addColumn(db, "relations", "context", "TEXT");
  addColumn(db, "events", "context", "TEXT");

  // Where an entity's picture came from, and whether we have already looked.
  // Sources have carried a meta_json since the start; entities now need one for
  // the same reason — a miss has to be remembered or every page load re-asks.
  addColumn(db, "entities", "meta_json", "TEXT NOT NULL DEFAULT '{}'");

  // Evidence you threw out, and when. The reason lives in evidence_discards;
  // these two columns are the live state, so every query that reads evidence can
  // exclude it with one predicate instead of a join.
  addColumn(db, "mentions", "discarded_at", "TEXT");
  addColumn(db, "mentions", "discard_reason", "TEXT");

  // Which model read the passage this mention came from. Stamped by the
  // extractor from what the provider reported; NULL for a mention the sweep
  // matched by name alone, or when the call never said. Added here rather
  // than in migrate-queue.ts so the live_mentions view, rebuilt further down,
  // carries the column from the first boot.
  addColumn(db, "mentions", "model", "TEXT");

  // A heading you chose yourself, which automatic renaming must not overrule.
  //
  // `bestName` picks the display name by scoring the recorded surface forms,
  // and it is usually right — but it is a heuristic, and it re-runs on every
  // new alias. Without somewhere to record that you have decided, correcting a
  // heading by hand lasts only until the next mention arrives.
  addColumn(db, "entities", "name_locked", "INTEGER NOT NULL DEFAULT 0");

  db.exec(`
    -- Questions put to the whole corpus, with the answer and what it rested on.
    CREATE TABLE IF NOT EXISTS questions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      question    TEXT    NOT NULL,
      answer_md   TEXT,
      -- Mention and chunk ids the answer cited, so it can be re-checked later.
      evidence    TEXT    NOT NULL DEFAULT '[]',
      tag_id      INTEGER REFERENCES tags(id) ON DELETE SET NULL,
      tokens_in   INTEGER NOT NULL DEFAULT 0,
      tokens_out  INTEGER NOT NULL DEFAULT 0,
      state       TEXT    NOT NULL DEFAULT 'pending',
      error       TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Study material, generated from evidence and reviewed over time.
    CREATE TABLE IF NOT EXISTS cards (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT    NOT NULL DEFAULT 'card',   -- card | quiz
      front       TEXT    NOT NULL,
      back        TEXT    NOT NULL,
      -- For quiz cards: the wrong answers, as JSON.
      distractors TEXT    NOT NULL DEFAULT '[]',
      entity_id   INTEGER REFERENCES entities(id) ON DELETE CASCADE,
      mention_id  INTEGER REFERENCES mentions(id) ON DELETE SET NULL,
      source_id   INTEGER REFERENCES sources(id) ON DELETE CASCADE,
      tag_id      INTEGER REFERENCES tags(id) ON DELETE SET NULL,
      -- Leitner-style scheduling: box drives how far ahead due_at is set.
      box         INTEGER NOT NULL DEFAULT 0,
      due_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      reviews     INTEGER NOT NULL DEFAULT 0,
      lapses      INTEGER NOT NULL DEFAULT 0,
      last_result TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due_at);
    CREATE INDEX IF NOT EXISTS idx_cards_entity ON cards(entity_id);

    -- Passages you have actually read.
    --
    -- Progress used to be scrollTop over scrollHeight, which measures the
    -- scrollbar rather than the reader: flicking to the end of a book reported
    -- it as finished. A passage lands here only after it has held still in the
    -- reading band long enough to have been read, or because you said so.
    CREATE TABLE IF NOT EXISTS read_passages (
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      chunk_id  INTEGER NOT NULL REFERENCES chunks(id)  ON DELETE CASCADE,
      -- 'read' when you dwelled on it, 'marked' when you said so outright.
      how       TEXT    NOT NULL DEFAULT 'read',
      at        TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source_id, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS idx_read_passages ON read_passages(source_id);

    -- Places in a source you marked deliberately.
    --
    -- Distinct from sources.bookmark_chunk, which is only ever "where I stopped"
    -- and is overwritten every time you scroll. A bookmark is a decision, so it
    -- persists until you remove it, and there can be as many as you like.
    CREATE TABLE IF NOT EXISTS bookmarks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      chunk_id  INTEGER NOT NULL REFERENCES chunks(id)  ON DELETE CASCADE,
      offset    REAL    NOT NULL DEFAULT 0,
      -- The opening words where you marked, so the list reads as the book does
      -- rather than as a column of passage numbers.
      excerpt   TEXT,
      note      TEXT,
      created_at TEXT   NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bookmarks_source ON bookmarks(source_id, chunk_id);

    -- Your own writing. The one part of Corpus nothing is generated into.
    CREATE TABLE IF NOT EXISTS drafts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT    NOT NULL DEFAULT 'Untitled',
      body_md    TEXT    NOT NULL DEFAULT '',
      -- The last fact-check, as JSON. Advisory only: it never edits the draft.
      check_json TEXT,
      checked_at TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Material you gathered beside a draft.
    --
    -- The text is COPIED, not referenced. Study cards learned this the hard way:
    -- they pointed at mention rows, re-extraction deletes and recreates those,
    -- and thirty of thirty-seven cards silently lost their evidence. Notes you
    -- collected for something you are writing must not be able to evaporate.
    CREATE TABLE IF NOT EXISTS draft_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id   INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      kind       TEXT    NOT NULL DEFAULT 'quote',   -- quote | passage | entry
      text       TEXT    NOT NULL,
      citation   TEXT,
      note       TEXT,
      entity_id  INTEGER REFERENCES entities(id) ON DELETE SET NULL,
      mention_id INTEGER REFERENCES mentions(id) ON DELETE SET NULL,
      chunk_id   INTEGER REFERENCES chunks(id)   ON DELETE SET NULL,
      source_id  INTEGER REFERENCES sources(id)  ON DELETE SET NULL,
      seq        INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_draft_notes ON draft_notes(draft_id, seq);

    -- The works a draft cites.
    --
    -- Two kinds, deliberately in one table: sources from your library, and
    -- everything else. A bibliography that could only hold what you happened to
    -- have ingested would be useless for real writing — half of what anyone
    -- cites is a book they read elsewhere — and keeping outside references in a
    -- separate place would mean two numbering schemes in one document.
    CREATE TABLE IF NOT EXISTS draft_citations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id   INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      -- 'library' when it points at a source here, 'outside' when you typed it.
      origin     TEXT    NOT NULL DEFAULT 'library',
      -- The rendered note, which is what appears at the foot of the page. Kept
      -- as text so it survives the source being re-extracted or removed.
      text       TEXT    NOT NULL,
      author     TEXT,
      title      TEXT,
      year       TEXT,
      locator    TEXT,
      url        TEXT,
      quote      TEXT,
      source_id  INTEGER REFERENCES sources(id)  ON DELETE SET NULL,
      mention_id INTEGER REFERENCES mentions(id) ON DELETE SET NULL,
      seq        INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_draft_citations ON draft_citations(draft_id, seq);

    -- Words looked up while reading, kept so the same word is never fetched
    -- twice. A row with json = 'null' is a remembered miss.
    CREATE TABLE IF NOT EXISTS dictionary (
      word       TEXT NOT NULL,
      lang       TEXT NOT NULL,
      json       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (word, lang)
    );

    -- Evidence you rejected, and the reason you gave.
    --
    -- Keyed by the entity's match key and the text of the quote rather than by
    -- mention id, because mention ids are not durable: re-extracting a source
    -- deletes every mention it produced and writes new ones. Study cards learned
    -- that lesson expensively (see rebuildCards). A verdict you gave by hand is
    -- worth more than the row it was given about, so it is stored where nothing
    -- in the pipeline can destroy it, and re-applied to whatever comes back.
    CREATE TABLE IF NOT EXISTS evidence_discards (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      -- The subject it was filed under. The id is a convenience that may go
      -- null; entity_norm is what the ledger actually matches on, because it
      -- survives the entity being merged, renamed, or rebuilt.
      entity_id   INTEGER REFERENCES entities(id) ON DELETE SET NULL,
      entity_norm TEXT    NOT NULL,
      entity_name TEXT    NOT NULL,
      entity_type TEXT    NOT NULL,
      -- The quote, copied. quote_key is its normalised form, which is what a
      -- re-extracted passage is compared against.
      quote       TEXT    NOT NULL,
      quote_key   TEXT    NOT NULL,
      surface     TEXT,
      source_id   INTEGER REFERENCES sources(id) ON DELETE SET NULL,
      chunk_id    INTEGER REFERENCES chunks(id)  ON DELETE SET NULL,
      -- One of the reasons in lib/audit.ts, and your own words about this case.
      reason      TEXT    NOT NULL,
      note        TEXT,
      -- 'entity': a fact about this subject. 'library': a standing correction
      -- that applies everywhere.
      scope       TEXT    NOT NULL DEFAULT 'entity',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    -- One verdict per quote per subject: discarding the same passage twice is a
    -- correction, not a second opinion.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_discards_key
      ON evidence_discards(entity_norm, quote_key);
    CREATE INDEX IF NOT EXISTS idx_discards_entity ON evidence_discards(entity_id);
    CREATE INDEX IF NOT EXISTS idx_discards_source ON evidence_discards(source_id);

    -- Things you might write, before they are things you are writing.
    --
    -- Kept apart from drafts on purpose. A draft is prose with a word count and
    -- a fact-check; an idea is a sentence and a hunch, and putting the two in
    -- one list means either the ideas look like abandoned drafts or the drafts
    -- get lost among them. An idea graduates by producing a draft, and keeps a
    -- pointer to it so the thinking behind a piece stays findable afterwards.
    CREATE TABLE IF NOT EXISTS ideas (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT    NOT NULL DEFAULT 'Untitled',
      -- The thought itself, in your words.
      note       TEXT    NOT NULL DEFAULT '',
      -- 'seed' | 'developing' | 'drafted' | 'parked'
      state      TEXT    NOT NULL DEFAULT 'seed',
      -- The draft this became, once it became one.
      draft_id   INTEGER REFERENCES drafts(id) ON DELETE SET NULL,
      seq        INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ideas_state ON ideas(state, seq);

    -- The outline: the points an idea would have to make, in order.
    --
    -- Rows rather than a blob of markdown, because the useful operations on an
    -- outline are reordering and indenting single points, and doing that to a
    -- text field means reparsing it on every keystroke and losing the cursor.
    CREATE TABLE IF NOT EXISTS outline_points (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      idea_id    INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      text       TEXT    NOT NULL DEFAULT '',
      -- 0 is a section, 1 a point under it, 2 a note under that. Two levels of
      -- nesting is as much as an outline can hold before it stops being one.
      depth      INTEGER NOT NULL DEFAULT 0,
      seq        INTEGER NOT NULL DEFAULT 0,
      -- Evidence you have already decided belongs here. Copied, not referenced,
      -- for the reason draft_notes are: re-extraction destroys mention rows.
      quote      TEXT,
      citation   TEXT,
      entity_id  INTEGER REFERENCES entities(id) ON DELETE SET NULL,
      source_id  INTEGER REFERENCES sources(id)  ON DELETE SET NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outline_idea ON outline_points(idea_id, seq);

    -- Sentences an entry asserts that its own citations do not bear out.
    --
    -- Coverage said every entry was complete because the pipeline rewrites
    -- until every passage is cited — it measured its own loop, not the truth of
    -- anything. This is the other half: each cited sentence read back against
    -- the passages it cites. A sentence like "Al Saud is the ruling dynasty of
    -- Saudi Arabia", hung off three quotes about somebody else entirely, is
    -- true about the world, absent from the evidence, and indistinguishable
    -- from a sound sentence to anyone reading the entry.
    CREATE TABLE IF NOT EXISTS entry_flags (
      id          INTEGER PRIMARY KEY,
      entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      sentence    TEXT    NOT NULL,
      -- 'unsupported': the cited passages do not say this at all.
      -- 'overstated':  they say something weaker or narrower than the claim.
      verdict     TEXT    NOT NULL,
      note        TEXT,
      mention_ids TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_entry_flags_entity ON entry_flags(entity_id);

    -- An entry, or its connections, checked against the open web on request.
    -- The one place Corpus looks outside your sources; it reports and never
    -- edits. The latest check of each kind is kept. See lib/pipeline/webcheck.ts.
    CREATE TABLE IF NOT EXISTS web_checks (
      id          INTEGER PRIMARY KEY,
      entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      -- 'entry' or 'connections'.
      scope       TEXT    NOT NULL,
      report_json TEXT    NOT NULL,
      checked_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (entity_id, scope)
    );

    -- The same check run on a draft or a source rather than a subject's entry.
    -- The latest one per target is kept, its leads inside the report: the
    -- Research inbox files leads under a subject, and these have none.
    CREATE TABLE IF NOT EXISTS text_web_checks (
      target      TEXT    NOT NULL,   -- 'draft' | 'source'
      target_id   INTEGER NOT NULL,
      report_json TEXT    NOT NULL,
      checked_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (target, target_id)
    );

    -- The Research inbox: what a web check turned up along the way — a page,
    -- a record, a public post, a shipment worth tracking — that the library
    -- does not have yet. Apart from the news inbox on purpose: these were
    -- looked for, about one subject, and nothing reaches the library until you
    -- keep it. 'new', 'kept' (then source_id says where it went) or 'dismissed'.
    CREATE TABLE IF NOT EXISTS research_finds (
      id          INTEGER PRIMARY KEY,
      entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      scope       TEXT    NOT NULL,
      url         TEXT    NOT NULL,
      title       TEXT,
      why         TEXT    NOT NULL,
      kind        TEXT    NOT NULL DEFAULT 'source',
      state       TEXT    NOT NULL DEFAULT 'new',
      source_id   INTEGER REFERENCES sources(id) ON DELETE SET NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (entity_id, url)
    );
    CREATE INDEX IF NOT EXISTS idx_research_finds_state ON research_finds(state, created_at);

    -- A zip or a folder of documents, brought in whole. Its files land first,
    -- listed and unread, and are read when you say so. See lib/folders.ts.
    CREATE TABLE IF NOT EXISTS folders (
      id          INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      origin      TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    -- 'waiting', 'queued', 'added' (source_id says which source it became),
    -- 'skipped' by you, 'unsupported' (a kind of file Corpus cannot read), 'failed'.
    CREATE TABLE IF NOT EXISTS folder_files (
      id          INTEGER PRIMARY KEY,
      folder_id   INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      rel_path    TEXT    NOT NULL,
      size        INTEGER NOT NULL DEFAULT 0,
      state       TEXT    NOT NULL DEFAULT 'waiting',
      source_id   INTEGER REFERENCES sources(id) ON DELETE SET NULL,
      error       TEXT,
      UNIQUE (folder_id, rel_path)
    );

    -- One-off repairs, so they do not fight the user afterwards.
    CREATE TABLE IF NOT EXISTS applied (
      key        TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Columns on tables created in the block above, so they have to come after
  // it — on a fresh database the table does not exist until then.
  //
  // The draft as rich text. `body_md` stays as the plain-text form the
  // fact-check reads, so neither has to be derived from the other at read time.
  addColumn(db, "drafts", "body_html", "TEXT NOT NULL DEFAULT ''");

  // How much of a passage you have read, 0 to 1. A passage of a book runs to
  // several pages, so whole passages were far too coarse a unit: "Read to here"
  // counted the rest of the passage you stopped in, and reading mode counted
  // nothing until its last paragraph. Rows from before this were whole passages.
  addColumn(db, "read_passages", "share", "REAL NOT NULL DEFAULT 1");

  // Evidence that still counts.
  //
  // Every read that feeds a model, a count, or a page goes through this rather
  // than through `mentions`, so a passage you rejected cannot come back by way
  // of a query somebody forgot to filter. Writes still address the table.
  //
  // Recreated on every boot on purpose: SQLite expands `SELECT *` when a view
  // is created, so a view made before the last ALTER TABLE would be missing the
  // columns added since and would go on serving the old shape for ever.
  db.exec(`
    DROP VIEW IF EXISTS live_mentions;
    CREATE VIEW live_mentions AS SELECT * FROM mentions WHERE discarded_at IS NULL;
  `);

  once(db, "renormalise-non-persons", () => repairOrgKeys(db));
  once(db, "promote-canonical-names", () => promoteNames(db));
  once(db, "fold-bare-surnames", () => foldFragments(db));
  // The rank-stripping rule changed after the first pass, so names get one
  // more look. Keyed separately so it does not re-run either.
  once(db, "promote-canonical-names-2", () => promoteNames(db));

  // Titles of more than one word — "Prime Minister", "Crown Prince" — were
  // invisible to the word-by-word stripper, so they stayed in both the match
  // key and the heading.
  once(db, "strip-compound-titles", () => repairPersonKeys(db));
  once(db, "promote-canonical-names-3", () => promoteNames(db));

  // Headings had taken to carrying date ranges — "Second Intifada (2000–2008)" —
  // which settle in the title a question the sources disagree about, and which
  // the entry's own contradictions record as unsettled. The name identifies the
  // thing; the dates belong where they can be qualified and cited.
  once(db, "strip-dates-from-names", () => promoteNames(db));

  // Study cards used to hang on the rows re-extraction routinely destroys.
  once(db, "cards-keep-their-evidence", () => rebuildCards(db));

  // Everything already in the library was queued in full at ingest, so the
  // stamp is backdated to match. Without it, switching an existing book to
  // read-along would see every passage as never-queued and send the whole book
  // a second time — which is the one thing read-along exists to prevent.
  once(db, "backfill-chunk-queued-at", () => {
    const r = db
      .prepare(
        "UPDATE chunks SET queued_at = COALESCE(extracted_at, datetime('now')) WHERE queued_at IS NULL"
      )
      .run();
    if (r.changes > 0) console.log(`[corpus] backdated ${r.changes} passage(s) as already queued`);
  });

  // --- 2026-09-03 newsroom audit --------------------------------------------

  // When a source was published, as an ISO datetime, and where. Books have a
  // year; news has a timestamp, and everything that makes news usable — "what
  // changed since yesterday", a chronology, resolving "on Tuesday" — is a query
  // over that timestamp. `year` stays for citations and older rows.
  addColumn(db, "sources", "published_at", "TEXT");
  addColumn(db, "sources", "outlet", "TEXT");
  addColumn(db, "sources", "section", "TEXT");
  addColumn(db, "sources", "dateline", "TEXT");
  // The URL with tracking stripped and the host lower-cased: what two feeds
  // carrying the same story are matched on.
  addColumn(db, "sources", "canonical_url", "TEXT");
  // A note in your words about how far to trust this outlet or document.
  addColumn(db, "sources", "reliability", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sources_published ON sources(published_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sources_canonical ON sources(canonical_url)");

  // Who is asserting a claim, and what kind of claim it is. "The tariff will
  // take effect Monday" reported as officials' words is a different record
  // from the same sentence stated by the source itself, and journalism turns
  // on the difference. Filled by extraction; null on older rows.
  addColumn(db, "mentions", "attribution", "TEXT");
  addColumn(db, "mentions", "claim_kind", "TEXT");

  // How many times the writer has been run against the current evidence set,
  // and how many of those were forced by verification flags. Both reset when
  // the evidence changes. This is the memory the rewrite loop lacked: without
  // it, an entry the writer could not push past a coverage target was queued
  // again on every idle sweep, for ever.
  addColumn(db, "entries", "passes", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "entries", "flag_rewrites", "INTEGER NOT NULL DEFAULT 0");
  // The language the body is written in, so a changed setting knows what to
  // rewrite.
  addColumn(db, "entries", "lang", "TEXT");

  // The writer emitted `[[m:1], [m:2]]` for a while and nothing could read it:
  // 106 entries had citations that did not render, did not count and were not
  // verified. Rewritten in place into the one grammar. Pure string work.
  once(db, "normalise-citation-markers", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { normaliseMarkers } = require("../markers") as { normaliseMarkers: (s: string) => string };
    let fixed = 0;
    const rows = db.prepare("SELECT entity_id, body_md FROM entries").all() as {
      entity_id: number;
      body_md: string;
    }[];
    const update = db.prepare("UPDATE entries SET body_md=? WHERE entity_id=?");
    for (const r of rows) {
      const body = normaliseMarkers(r.body_md);
      if (body !== r.body_md) {
        update.run(body, r.entity_id);
        fixed++;
      }
    }
    const revs = db.prepare("SELECT id, body_md FROM entry_revisions").all() as {
      id: number;
      body_md: string;
    }[];
    const updateRev = db.prepare("UPDATE entry_revisions SET body_md=? WHERE id=?");
    for (const r of revs) {
      const body = normaliseMarkers(r.body_md);
      if (body !== r.body_md) updateRev.run(body, r.id);
    }
    if (fixed > 0) console.log(`[corpus] repaired citation markers in ${fixed} entr${fixed === 1 ? "y" : "ies"}`);
  });

  migrateQueue(db);
  once(db, "supersede-duplicate-entries", () => supersedeDuplicateEntries(db));
  migrateFeeds(db);
  migrateWatch(db);
  migrateCalendar(db);
  migrateLessons(db);
  migrateBundles(db);
  migrateEscapes(db);
  migrateCitations(db);
  migrateTranslations(db);
  migrateVectors(db);
}

/**
 * Rebuilds the cards table so a card outlives its evidence rows.
 *
 * The original table pointed at a mention (`ON DELETE SET NULL`) and an entity
 * (`ON DELETE CASCADE`), and re-extracting a source deletes and recreates both.
 * The result was silent and total: every existing card had lost the passage it
 * was made from, and thirty of thirty-seven cards had been deleted outright
 * when their entity was momentarily removed. A card you cannot check is exactly
 * the thing this app exists to avoid, and one that vanishes is worse.
 *
 * So the quote now lives on the card itself. The mention id stays as a link
 * when it still resolves, but nothing depends on it.
 */
function rebuildCards(db: Database.Database) {
  const before = (db.prepare("SELECT COUNT(*) AS n FROM cards").get() as { n: number }).n;

  db.exec(`
    ALTER TABLE cards RENAME TO cards_old;

    CREATE TABLE cards (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT    NOT NULL DEFAULT 'card',
      front       TEXT    NOT NULL,
      back        TEXT    NOT NULL,
      distractors TEXT    NOT NULL DEFAULT '[]',
      -- The evidence, copied rather than referenced: re-extraction rewrites
      -- mentions wholesale and a card must survive that.
      quote       TEXT,
      locator     TEXT,
      entity_name TEXT,
      entity_id   INTEGER REFERENCES entities(id) ON DELETE SET NULL,
      mention_id  INTEGER REFERENCES mentions(id) ON DELETE SET NULL,
      source_id   INTEGER REFERENCES sources(id) ON DELETE CASCADE,
      tag_id      INTEGER REFERENCES tags(id)    ON DELETE SET NULL,
      box         INTEGER NOT NULL DEFAULT 0,
      due_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      reviews     INTEGER NOT NULL DEFAULT 0,
      lapses      INTEGER NOT NULL DEFAULT 0,
      last_result TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Whatever evidence is still reachable is carried across; for cards whose
    -- mention was already deleted there is nothing left to recover.
    INSERT INTO cards (id, kind, front, back, distractors, quote, locator,
                       entity_name, entity_id, mention_id, source_id, tag_id,
                       box, due_at, reviews, lapses, last_result, created_at)
      SELECT c.id, c.kind, c.front, c.back, c.distractors,
             m.quote, NULL, e.canonical_name,
             c.entity_id, c.mention_id, c.source_id, c.tag_id,
             c.box, c.due_at, c.reviews, c.lapses, c.last_result, c.created_at
        FROM cards_old c
   LEFT JOIN mentions m ON m.id = c.mention_id
   LEFT JOIN entities e ON e.id = c.entity_id;

    DROP TABLE cards_old;
    CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due_at);
    CREATE INDEX IF NOT EXISTS idx_cards_entity ON cards(entity_id);
  `);

  const kept = (db.prepare("SELECT COUNT(*) AS n FROM cards").get() as { n: number }).n;
  console.log(`[corpus] cards now keep their own evidence (${kept} of ${before} carried over)`);
}

/** Runs a repair exactly once in the life of a database. */
function once(db: Database.Database, key: string, fn: () => void) {
  const done = db.prepare("SELECT 1 AS x FROM applied WHERE key=?").get(key);
  if (done) return;
  fn();
  db.prepare("INSERT OR IGNORE INTO applied (key) VALUES (?)").run(key);
}

/**
 * Honorific stripping used to run on every entity type, so "General Motors"
 * was stored under the key "motors" and "King Fahd University" under "fahd
 * university". Those keys are how names are matched, so they have to be
 * rebuilt — otherwise the same organisation seen again would fail to match its
 * own record and split into a second entity.
 */
function repairOrgKeys(db: Database.Database) {
  // Imported lazily: lib/normalize has no database dependency and this keeps
  // the migration module free of a cycle at load time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { normalize } = require("../normalize") as { normalize: (s: string, t?: string) => string };

  const entities = db
    .prepare("SELECT id, canonical_name, normalized, type FROM entities WHERE type != 'person'")
    .all() as { id: number; canonical_name: string; normalized: string; type: string }[];

  let fixed = 0;
  const updateEntity = db.prepare("UPDATE entities SET normalized=? WHERE id=?");
  const aliasesOf = db.prepare("SELECT id, surface FROM aliases WHERE entity_id=?");
  const updateAlias = db.prepare("UPDATE OR IGNORE aliases SET normalized=? WHERE id=?");

  db.transaction(() => {
    for (const e of entities) {
      const correct = normalize(e.canonical_name, e.type);
      if (correct && correct !== e.normalized) {
        updateEntity.run(correct, e.id);
        fixed++;
      }
      for (const a of aliasesOf.all(e.id) as { id: number; surface: string }[]) {
        updateAlias.run(normalize(a.surface, e.type), a.id);
      }
    }
  })();

  if (fixed > 0) {
    console.log(`[corpus] repaired ${fixed} organisation name key(s) that had a title stripped`);
  }
}

/**
 * Recomputes person match keys now that two-word titles come off.
 *
 * Unlike the organisation pass this can create collisions — "Prime Minister
 * Netanyahu" and "Netanyahu" were two keys and are now one — so where a
 * recomputed key already belongs to another person, the two are merged rather
 * than left as duplicates. The survivor is whichever has more evidence behind
 * it, which is also the one whose entry is worth keeping.
 */
function repairPersonKeys(db: Database.Database) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { normalize } = require("../normalize") as { normalize: (s: string, t?: string) => string };

  const people = db
    .prepare(
      `SELECT e.id, e.canonical_name, e.normalized,
              (SELECT COUNT(*) FROM mentions m WHERE m.entity_id = e.id) AS mentions
         FROM entities e
        WHERE e.type = 'person' AND e.merged_into IS NULL
        ORDER BY mentions DESC, e.id`
    )
    .all() as { id: number; canonical_name: string; normalized: string; mentions: number }[];

  const updateEntity = db.prepare("UPDATE entities SET normalized=? WHERE id=?");
  const aliasesOf = db.prepare("SELECT id, surface FROM aliases WHERE entity_id=?");
  const updateAlias = db.prepare("UPDATE OR IGNORE aliases SET normalized=? WHERE id=?");

  // Ordered by evidence, so the first holder of a key is the one that keeps it.
  const owner = new Map<string, number>();
  let rekeyed = 0;
  let merged = 0;

  db.transaction(() => {
    for (const p of people) {
      const key = normalize(p.canonical_name, "person");
      if (!key) continue;

      const existing = owner.get(key);
      if (existing !== undefined && existing !== p.id) {
        mergeInto(db, p.id, existing);
        merged++;
        continue;
      }
      owner.set(key, p.id);

      if (key !== p.normalized) {
        updateEntity.run(key, p.id);
        rekeyed++;
      }
      for (const a of aliasesOf.all(p.id) as { id: number; surface: string }[]) {
        updateAlias.run(normalize(a.surface, "person"), a.id);
      }
    }
  })();

  if (rekeyed || merged) {
    console.log(
      `[corpus] re-keyed ${rekeyed} person name(s) past a compound title` +
        (merged ? `, merging ${merged} that turned out to be duplicates` : "")
    );
  }
}

/** Moves everything hanging off one entity onto another and tombstones it. */
function mergeInto(db: Database.Database, loser: number, winner: number) {
  db.prepare("UPDATE OR IGNORE mentions SET entity_id=? WHERE entity_id=?").run(winner, loser);
  db.prepare("UPDATE OR IGNORE aliases  SET entity_id=? WHERE entity_id=?").run(winner, loser);
  db.prepare("UPDATE OR IGNORE events   SET entity_id=? WHERE entity_id=?").run(winner, loser);
  db.prepare("UPDATE OR IGNORE relations SET from_entity=? WHERE from_entity=?").run(winner, loser);
  db.prepare("UPDATE OR IGNORE relations SET to_entity=?   WHERE to_entity=?").run(winner, loser);
  // The survivor's entry no longer accounts for the evidence it just inherited.
  db.prepare("UPDATE entities SET entry_state='stale' WHERE id=? AND entry_state!='none'").run(winner);
  db.prepare("DELETE FROM entries WHERE entity_id=?").run(loser);
  db.prepare("UPDATE entities SET merged_into=? WHERE id=?").run(winner, loser);
}

/**
 * The display name used to be whichever surface form was seen first, which is
 * why entries were headed "President Truman" while holding "Harry S. Truman"
 * as an alias. Identity was always right; only the label was wrong.
 */
function promoteNames(db: Database.Database) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { bestName } = require("../canonical") as {
    bestName: (c: string, a: string[], t: string) => string | null;
  };

  const rows = db
    .prepare(
      `SELECT e.id, e.canonical_name, e.type,
              (SELECT group_concat(a.surface, char(31)) FROM aliases a WHERE a.entity_id = e.id) AS aliases
         FROM entities e WHERE e.merged_into IS NULL`
    )
    .all() as { id: number; canonical_name: string; type: string; aliases: string | null }[];

  let renamed = 0;
  // Never overrules a heading you set yourself.
  const update = db.prepare("UPDATE entities SET canonical_name=? WHERE id=? AND name_locked=0");

  db.transaction(() => {
    for (const r of rows) {
      const aliases = (r.aliases ?? "").split(String.fromCharCode(31)).filter(Boolean);
      const better = bestName(r.canonical_name, aliases, r.type);
      if (better) {
        update.run(better, r.id);
        renamed++;
      }
    }
  })();

  if (renamed > 0) console.log(`[corpus] gave ${renamed} entit(y|ies) a better display name`);
}

/**
 * Folds the lone surnames already in the library into their full names, the
 * same way resolution now does for new material — but only where the source
 * leaves no doubt. See foldBareNames in lib/pipeline/resolve.ts.
 */
function foldFragments(db: Database.Database) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { foldBareNames } = require("../pipeline/resolve") as {
    foldBareNames: (rows: unknown[], handle: Database.Database) => void;
  };

  const before = db
    .prepare("SELECT COUNT(*) AS n FROM entities WHERE type='person' AND merged_into IS NULL")
    .get() as { n: number };

  foldBareNames(
    db
      .prepare(
        `SELECT e.id, e.canonical_name, e.normalized, e.disambiguator, e.embedding,
                (SELECT COUNT(*) FROM mentions m WHERE m.entity_id = e.id) AS mentions
           FROM entities e WHERE e.type='person' AND e.merged_into IS NULL
          ORDER BY mentions DESC`
      )
      .all(),
    db
  );

  const after = db
    .prepare("SELECT COUNT(*) AS n FROM entities WHERE type='person' AND merged_into IS NULL")
    .get() as { n: number };

  if (before.n !== after.n) {
    console.log(`[corpus] folded ${before.n - after.n} lone surname(s) into their full names`);
  }
}
