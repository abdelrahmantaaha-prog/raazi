import { db, tx } from "./db";

/**
 * One event, many accounts.
 *
 * Six outlets running the same wire report is six sources and one story, and a
 * brief that does not know the difference reads as though six things happened.
 * Grouping is deliberately conservative, for the same reason entity resolution
 * is: a wrongly merged story hides an account, which is invisible, while a
 * story left split is merely untidy and one click from fixed.
 *
 * Two signals have to agree, inside a window:
 *
 *   - the headlines overlap in their significant words (a Jaccard score over
 *     word shingles, which survives the rewriting outlets do to a wire lede);
 *   - the accounts share entities the pedia already knows about.
 *
 * Neither alone is enough. Headlines about two different tariff rounds look
 * alike; two genuinely different stories about the same minister share
 * entities all day.
 */

/** How far apart two accounts of the same story may be published. */
const WINDOW_HOURS = 72;

/** Headline overlap required before the second signal is even consulted.
 *  Low, because the second signal is what decides: "McConnell returns after
 *  months-long absence for crucial vote" shares two words in five with the
 *  wire's headline, and the same three Kentuckians in its lede. */
const TITLE_FLOOR = 0.34;

/** With this much headline overlap, shared entities are not required. */
const TITLE_CERTAIN = 0.72;

/** Shared known entities required at the lower headline threshold. */
const MIN_SHARED_ENTITIES = 2;

/**
 * A headline with fewer significant words than this cannot group on its own.
 *
 * "What in the World?" is a column, and every instalment of it shares the one
 * word that survives the stop list. Sixteen pieces about sixteen different
 * things were filed as one story because 1/1 is a perfect overlap. A short
 * headline still groups — but only with the second signal agreeing.
 */
const MIN_TITLE_WORDS = 3;

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "in", "on", "at", "to", "for", "with", "by",
  "from", "as", "is", "are", "was", "were", "be", "been", "will", "would", "could", "should",
  "says", "say", "said", "after", "over", "amid", "new", "how", "why", "what", "who",
  "his", "her", "its", "their", "this", "that", "these", "those", "more", "than", "into",
  // How outlets dress the same event: the wire says "returns for first time
  // since June", the rewrite says "returns after three-month absence". The
  // words about time are not the story, and they were keeping two accounts
  // of one return apart.
  "live", "updates", "update", "latest", "breaking", "exclusive", "analysis", "opinion",
  "explained", "explainer", "video", "watch", "first", "time", "since", "ahead", "back",
  "just", "now", "here", "today", "tonight", "yesterday", "tomorrow", "week", "weeks",
  "month", "months", "year", "years", "day", "days", "one", "two", "three", "four", "five",
  "amid", "again", "still", "has", "have", "had", "not", "out", "off", "all", "some",
]);

/** The words of a headline that carry its identity. */
export function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Whether two headlines are alike enough to be one story on their own.
 *
 * The overlap has to be high AND both headlines have to have said something:
 * a one- or two-word identity is what a column title or a wire slug leaves
 * behind, and it matches every instalment.
 */
export function titlesAgree(a: string, b: string): boolean {
  const A = new Set(titleWords(a));
  const B = new Set(titleWords(b));
  if (Math.min(A.size, B.size) < MIN_TITLE_WORDS) return false;
  return titleSimilarity(a, b) >= TITLE_CERTAIN;
}

/** How much of an article's opening is read for the names in it. */
const LEDE_CHARS = 1_500;

/** Shared names required where the headlines merely resemble each other. */
const MIN_SHARED_NAMES = 2;

/**
 * The proper nouns an account opens with, as a stand-in for entities.
 *
 * The entity half of the test needs passages that have been extracted, and
 * an article waiting in the inbox has none: it was fetched and chunked and
 * nothing more. So for the first filing there was only ever the headline,
 * and two rewrites of one wire report that disagreed on wording opened two
 * stories. What the article itself says in its first paragraph is free to
 * read — capitalised words that are not starting a sentence are names,
 * near enough, in any Latin-script outlet — and "Mitch", "McConnell",
 * "Senate", "Kentucky" agree even when the headlines do not.
 *
 * Headlines are left out on purpose: outlets set them in Title Case, which
 * would make every word a name. The feed's own summary counts, since it is
 * prose. Arabic has no case and yields nothing here; those accounts wait for
 * extraction, as they always did.
 */
export function namesIn(text: string): Set<string> {
  const names = new Set<string>();
  // A capitalised word that opens a sentence is ambiguous — "Officials" —
  // unless the text uses it again, in which case it is what the text is
  // about: "Pennsylvania officials … Pennsylvania's governor".
  const seen = new Map<string, number>();
  for (const w of text.replace(/[^\p{L}\p{N}\s'’-]/gu, " ").split(/\s+/)) {
    const key = w.replace(/^['’]|['’]s?$/g, "").toLowerCase();
    if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const sentence of text.split(/(?<=[.!?؟])\s+|\n+/)) {
    const words = sentence.replace(/[^\p{L}\p{N}\s'’-]/gu, " ").split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/^['’]|['’]s?$/g, "");
      if (w.length < 3) continue;
      if (!/^\p{Lu}/u.test(w)) continue;
      const key = w.toLowerCase();
      if (STOP.has(key) || COMMON_NAMES.has(key)) continue;
      if (i === 0 && (seen.get(key) ?? 0) < 2) continue;
      names.add(key);
    }
  }
  return names;
}

/**
 * Names that are in every second lede on this beat and so identify nothing.
 *
 * The first regroup without this list folded 342 stories into 1,666 — every
 * piece that opened with "Trump", "Senate" and "Monday" agreed with every
 * other. Two shared names have to be two names that could not be in an
 * unrelated story: a person, a place, a bill, a company. The days and months
 * are here for the same reason; so are the parties and the chambers, and the
 * outlets, which name themselves in their own ledes.
 */
const COMMON_NAMES = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september",
  "october", "november", "december",
  "republican", "republicans", "democrat", "democrats", "democratic", "gop", "party",
  "senate", "house", "congress", "congressional", "capitol", "hill", "senator", "sen", "rep",
  "gov", "governor", "president", "presidential", "administration", "white", "washington",
  "american", "americans", "america", "united", "states", "federal", "government", "national",
  "supreme", "court", "justice", "department", "secretary", "office", "committee", "chairman",
  "trump", "canada", "canadian", "canadians", "ottawa", "parliament", "liberal", "liberals",
  "conservative", "conservatives", "ndp", "minister", "prime", "ministry", "mps", "commons",
  "news", "press", "associated", "reuters", "times", "post", "cnn", "bbc", "cbc", "npr", "pbs",
  "axios", "politico", "bloomberg", "guardian", "hill's", "mr", "mrs", "ms", "dr", "the",
  "north", "south", "east", "west", "new", "city", "state", "county", "us", "usa", "u.s",
]);

function namesOf(sourceId: number): Set<string> {
  const row = db()
    .prepare(
      `SELECT (SELECT c.text FROM chunks c WHERE c.source_id = s.id ORDER BY c.seq LIMIT 1) AS lede,
              (SELECT i.summary FROM feed_items i WHERE i.source_id = s.id LIMIT 1) AS summary
         FROM sources s WHERE s.id = ?`
    )
    .get(sourceId) as { lede: string | null; summary: string | null } | undefined;
  if (!row) return new Set();
  const summary = (row.summary ?? "").replace(/<[^>]+>/g, " ");
  return namesIn(`${(row.lede ?? "").slice(0, LEDE_CHARS)}\n${summary.slice(0, LEDE_CHARS)}`);
}

function storyNames(storyId: number): Set<string> {
  const names = new Set<string>();
  // The first few accounts only. A story of sixteen accounts opens with a
  // hundred names between them, and a union that wide agrees with anything.
  const accounts = db()
    .prepare(
      `SELECT ss.source_id FROM story_sources ss JOIN sources s ON s.id = ss.source_id
        WHERE ss.story_id = ? ORDER BY COALESCE(s.published_at, s.added_at) LIMIT 3`
    )
    .all(storyId) as { source_id: number }[];
  for (const a of accounts) for (const n of namesOf(a.source_id)) names.add(n);
  return names;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/**
 * The second signal: entities the pedia knows, or failing those, the names
 * the accounts open with. Whichever agrees more.
 */
function sharedSignals(sourceId: number, storyId: number, names: Set<string>): number {
  const entities = sharedEntities(sourceId, storyId);
  if (entities >= MIN_SHARED_ENTITIES) return entities;
  return Math.max(entities, overlap(names, storyNames(storyId)));
}

/** How much two headlines overlap, 0 to 1. */
export function titleSimilarity(a: string, b: string): number {
  const A = new Set(titleWords(a));
  const B = new Set(titleWords(b));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  // Jaccard would punish a long headline paired with a short one, which is the
  // normal shape of a wire report and its rewrite; this asks how much of the
  // *smaller* headline is present in the larger.
  return shared / Math.min(A.size, B.size);
}

/** A stable fingerprint of a headline, for the story row. */
export function shingle(title: string): string {
  return [...new Set(titleWords(title))].sort().slice(0, 12).join(" ");
}

interface Candidate {
  id: number;
  title: string;
  shingle: string;
  last_seen: string;
}

/**
 * Files a source with the story it belongs to, creating one if it is the first
 * account. Returns the story id, and whether it was newly created.
 */
export function fileSource(sourceId: number): { storyId: number; created: boolean } | null {
  const source = db()
    .prepare("SELECT id, title, COALESCE(published_at, added_at) AS at FROM sources WHERE id=?")
    .get(sourceId) as { id: number; title: string; at: string } | undefined;
  if (!source) return null;

  const existing = db()
    .prepare("SELECT story_id FROM story_sources WHERE source_id=?")
    .get(sourceId) as { story_id: number } | undefined;
  if (existing) return { storyId: existing.story_id, created: false };

  const candidates = db()
    .prepare(
      `SELECT s.id, s.title, s.shingle, s.last_seen
         FROM stories s
        WHERE s.last_seen >= datetime(?, '-${WINDOW_HOURS} hours')
          AND s.first_seen <= datetime(?, '+${WINDOW_HOURS} hours')
        ORDER BY s.last_seen DESC
        LIMIT 200`
    )
    .all(source.at, source.at) as Candidate[];

  let best: { story: Candidate; score: number } | null = null;
  // Read once, and only if a headline comes close enough to need it.
  let names: Set<string> | undefined;
  const mine = titleWords(source.title).length;
  for (const story of candidates) {
    const score = titleSimilarity(source.title, story.title);
    if (score < TITLE_FLOOR) continue;
    if (Math.min(mine, titleWords(story.title).length) < MIN_TITLE_WORDS) {
      // A headline that says almost nothing — a column's title, a wire slug
      // — matches only on entities the pedia knows, which means only once
      // the passages have been read. Names in a lede are not enough here:
      // the instalments of one column all open the same way.
      if (sharedEntities(sourceId, story.id) < MIN_SHARED_ENTITIES) continue;
    } else if (!titlesAgree(source.title, story.title)) {
      names ??= namesOf(sourceId);
      if (sharedSignals(sourceId, story.id, names) < MIN_SHARED_NAMES) continue;
    }
    if (!best || score > best.score) best = { story, score };
  }

  return tx(() => {
    if (best) {
      db()
        .prepare("INSERT OR IGNORE INTO story_sources (story_id, source_id, reason) VALUES (?, ?, ?)")
        .run(best.story.id, sourceId, `Headline overlap ${best.score.toFixed(2)} with "${best.story.title}".`);
      db()
        .prepare("UPDATE stories SET last_seen=MAX(last_seen, ?) WHERE id=?")
        .run(source.at, best.story.id);
      return { storyId: best.story.id, created: false };
    }

    const id = Number(
      db()
        .prepare("INSERT INTO stories (title, shingle, first_seen, last_seen) VALUES (?, ?, ?, ?)")
        .run(source.title, shingle(source.title), source.at, source.at).lastInsertRowid
    );
    db()
      .prepare("INSERT INTO story_sources (story_id, source_id, reason) VALUES (?, ?, 'First account.')")
      .run(id, sourceId);
    return { storyId: id, created: true };
  });
}

/**
 * Files a source again once its passages exist.
 *
 * The first filing happens the moment an article is fetched, before anything
 * has been extracted from it — so the entity half of the test has nothing to
 * work with and a genuine second account of a running story often opens a
 * story of its own. This runs after extraction, and only for a source that is
 * still alone in its story: if it has since been joined by others, or you have
 * named the story yourself, the grouping stands.
 */
export function refileSource(sourceId: number): { storyId: number; moved: boolean } | null {
  const current = db()
    .prepare(
      `SELECT ss.story_id, s.named_by,
              (SELECT COUNT(*) FROM story_sources x WHERE x.story_id = ss.story_id) AS accounts
         FROM story_sources ss JOIN stories s ON s.id = ss.story_id
        WHERE ss.source_id = ?`
    )
    .get(sourceId) as { story_id: number; named_by: string; accounts: number } | undefined;

  if (!current) {
    const filed = fileSource(sourceId);
    return filed ? { storyId: filed.storyId, moved: filed.created === false } : null;
  }
  if (current.accounts > 1 || current.named_by === "user") {
    return { storyId: current.story_id, moved: false };
  }

  const before = current.story_id;
  tx(() => {
    db().prepare("DELETE FROM story_sources WHERE source_id=?").run(sourceId);
    db().prepare("DELETE FROM stories WHERE id=? AND NOT EXISTS (SELECT 1 FROM story_sources WHERE story_id=?)").run(before, before);
  });

  const filed = fileSource(sourceId);
  if (!filed) return null;
  return { storyId: filed.storyId, moved: filed.storyId !== before };
}

/** How many known entities a source shares with a story's other accounts. */
function sharedEntities(sourceId: number, storyId: number): number {
  return (
    db()
      .prepare(
        `SELECT COUNT(DISTINCT m.entity_id) AS n
           FROM live_mentions m
          WHERE m.source_id = ?
            AND m.entity_id IN (
              SELECT DISTINCT m2.entity_id FROM live_mentions m2
               JOIN story_sources ss ON ss.source_id = m2.source_id
              WHERE ss.story_id = ?
            )`
      )
      .get(sourceId, storyId) as { n: number }
  ).n;
}

export interface StoryRow {
  id: number;
  title: string;
  pinned: number;
  named_by: string;
  first_seen: string;
  last_seen: string;
  accounts: number;
  outlets: string | null;
}

export function listStories(opts: { since?: string; limit?: number } = {}): StoryRow[] {
  return db()
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM story_sources ss WHERE ss.story_id=s.id) AS accounts,
              (SELECT group_concat(DISTINCT COALESCE(src.outlet, src.publisher))
                 FROM story_sources ss JOIN sources src ON src.id=ss.source_id
                WHERE ss.story_id=s.id) AS outlets
         FROM stories s
        WHERE (@since IS NULL OR s.last_seen >= @since)
        ORDER BY s.pinned DESC, s.last_seen DESC
        LIMIT @limit`
    )
    .all({ since: opts.since ?? null, limit: opts.limit ?? 100 }) as StoryRow[];
}

export function storyDetail(id: number) {
  const story = db().prepare("SELECT * FROM stories WHERE id=?").get(id) as StoryRow | undefined;
  if (!story) return undefined;
  const accounts = db()
    .prepare(
      `SELECT src.id, src.title, src.outlet, src.author, src.published_at, src.url, ss.reason,
              (SELECT COUNT(*) FROM live_mentions m WHERE m.source_id=src.id) AS passages
         FROM story_sources ss JOIN sources src ON src.id=ss.source_id
        WHERE ss.story_id=?
        ORDER BY COALESCE(src.published_at, src.added_at)`
    )
    .all(id) as {
    id: number;
    title: string;
    outlet: string | null;
    author: string | null;
    published_at: string | null;
    url: string | null;
    reason: string | null;
    passages: number;
  }[];

  const entities = db()
    .prepare(
      `SELECT e.id, e.canonical_name, e.type, COUNT(*) AS mentions
         FROM live_mentions m
         JOIN entities e ON e.id = m.entity_id AND e.merged_into IS NULL
        WHERE m.source_id IN (SELECT source_id FROM story_sources WHERE story_id=?)
        GROUP BY e.id ORDER BY mentions DESC LIMIT 25`
    )
    .all(id) as { id: number; canonical_name: string; type: string; mentions: number }[];

  // Named accounts_list rather than accounts: the story row already carries a
  // count under that name, and a page that shows both wants both.
  return { ...story, accounts_list: accounts, entities };
}

export function renameStory(id: number, title: string): boolean {
  return (
    db()
      .prepare("UPDATE stories SET title=?, shingle=?, named_by='user' WHERE id=?")
      .run(title, shingle(title), id).changes > 0
  );
}

export function setStoryPinned(id: number, pinned: boolean): boolean {
  return db().prepare("UPDATE stories SET pinned=? WHERE id=?").run(pinned ? 1 : 0, id).changes > 0;
}

/** Moves one account out of a story and into its own. Reversible by hand. */
export function splitAccount(sourceId: number): { storyId: number } | null {
  const source = db()
    .prepare("SELECT id, title, COALESCE(published_at, added_at) AS at FROM sources WHERE id=?")
    .get(sourceId) as { id: number; title: string; at: string } | undefined;
  if (!source) return null;

  return tx(() => {
    db().prepare("DELETE FROM story_sources WHERE source_id=?").run(sourceId);
    const id = Number(
      db()
        .prepare("INSERT INTO stories (title, shingle, named_by, first_seen, last_seen) VALUES (?, ?, 'user', ?, ?)")
        .run(source.title, shingle(source.title), source.at, source.at).lastInsertRowid
    );
    db()
      .prepare("INSERT INTO story_sources (story_id, source_id, reason) VALUES (?, ?, 'Separated by hand.')")
      .run(id, sourceId);
    // A story with nothing left in it is not a story.
    db().prepare("DELETE FROM stories WHERE id NOT IN (SELECT story_id FROM story_sources)").run();
    return { storyId: id };
  });
}

/** How far back the regroup looks. Two windows, so a story that began at
 *  the edge of one still meets the account that arrived in the next. */
const REGROUP_HOURS = 2 * WINDOW_HOURS;
const REGROUP_LIMIT = 300;
/** A name in this share of the stories on the table is the beat, not a story. */
const COMMON_SHARE = 0.08;

/**
 * Merges stories that were opened twice.
 *
 * Grouping happens as each account arrives, against the stories that exist
 * at that moment — so the second account of an event can open a story of its
 * own when its headline is a rewrite and its passages are not yet read, and
 * by the time the third arrives there are two stories for it to choose
 * between. This pass looks at the recent stories together, with everything
 * their accounts have said since, and folds the ones that are the same
 * event by the same two-signal rule. Only stories Corpus named itself and
 * nobody pinned: a story you named is a decision, and this does not overrule
 * one. Returns how many were folded in.
 */
export function regroupRecent(opts: { hours?: number; limit?: number } = {}): number {
  const hours = opts.hours ?? REGROUP_HOURS;
  const limit = opts.limit ?? REGROUP_LIMIT;
  const recent = db()
    .prepare(
      `SELECT s.id, s.title, s.first_seen, s.last_seen,
              (SELECT COUNT(*) FROM story_sources ss WHERE ss.story_id = s.id) AS accounts
         FROM stories s
        WHERE s.named_by = 'auto' AND s.pinned = 0
          AND s.last_seen >= datetime('now', '-${Math.max(1, Math.floor(hours))} hours')
        ORDER BY s.last_seen DESC
        LIMIT ?`
    )
    .all(limit) as { id: number; title: string; first_seen: string; last_seen: string; accounts: number }[];

  const gone = new Set<number>();
  const words = new Map(recent.map((s) => [s.id, titleWords(s.title).length]));

  // Names are read once per story, and a name that turns up in many of the
  // stories on the table is dropped from all of them: on a beat, the same
  // dozen surnames open half the ledes, and two of those shared is not two
  // stories agreeing, it is the beat.
  const raw = new Map<number, Set<string>>();
  const seenIn = new Map<string, number>();
  for (const s of recent) {
    if ((words.get(s.id) ?? 0) < MIN_TITLE_WORDS) continue;
    const n = storyNames(s.id);
    raw.set(s.id, n);
    for (const name of n) seenIn.set(name, (seenIn.get(name) ?? 0) + 1);
  }
  const everywhere = Math.max(3, Math.ceil(recent.length * COMMON_SHARE));
  const names = new Map<number, Set<string>>();
  for (const [id, n] of raw) names.set(id, new Set([...n].filter((x) => (seenIn.get(x) ?? 0) < everywhere)));
  const namesFor = (id: number) => names.get(id) ?? new Set<string>();

  const within = (a: string, b: string) =>
    Math.abs(new Date(a.replace(" ", "T") + (a.endsWith("Z") ? "" : "Z")).getTime() -
             new Date(b.replace(" ", "T") + (b.endsWith("Z") ? "" : "Z")).getTime()) <= WINDOW_HOURS * 3_600_000;

  let merged = 0;
  for (let i = 0; i < recent.length; i++) {
    const a = recent[i];
    if (gone.has(a.id)) continue;
    if ((words.get(a.id) ?? 0) < MIN_TITLE_WORDS) continue;
    for (let j = i + 1; j < recent.length; j++) {
      const b = recent[j];
      if (gone.has(b.id)) continue;
      if ((words.get(b.id) ?? 0) < MIN_TITLE_WORDS) continue;
      if (!within(a.first_seen, b.first_seen) && !within(a.last_seen, b.last_seen)) continue;
      const score = titleSimilarity(a.title, b.title);
      if (score < TITLE_FLOOR) continue;
      if (!titlesAgree(a.title, b.title) && overlap(namesFor(a.id), namesFor(b.id)) < MIN_SHARED_NAMES) continue;

      // The one with more accounts keeps its name; on a tie, the older.
      const [keep, drop] = b.accounts > a.accounts ? [b, a] : [a, b];
      mergeStories(keep.id, drop.id);
      gone.add(drop.id);
      keep.accounts += drop.accounts;
      names.set(keep.id, new Set([...namesFor(keep.id), ...namesFor(drop.id)]));
      merged++;
      if (drop.id === a.id) break;
    }
  }
  if (merged) console.log(`[corpus] stories: folded ${merged} duplicate${merged === 1 ? "" : "s"} into the story already running`);
  return merged;
}

/** Merges one story into another, keeping the target's name. */
export function mergeStories(keepId: number, dropId: number): boolean {
  if (keepId === dropId) return false;
  return tx(() => {
    const moved = db()
      .prepare("UPDATE OR IGNORE story_sources SET story_id=? WHERE story_id=?")
      .run(keepId, dropId).changes;
    db().prepare("DELETE FROM stories WHERE id=?").run(dropId);
    db()
      .prepare(
        `UPDATE stories SET last_seen = (SELECT MAX(COALESCE(src.published_at, src.added_at))
                                           FROM story_sources ss JOIN sources src ON src.id=ss.source_id
                                          WHERE ss.story_id=?)
          WHERE id=?`
      )
      .run(keepId, keepId);
    return moved >= 0;
  });
}
