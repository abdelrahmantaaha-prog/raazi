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

/**
 * How long a story stays open to new accounts, counted from its first.
 *
 * The window above is measured from a story's *last* account, and every
 * account that joins moves that forward, so a story that kept winning
 * matches never closed. A story is one event; a week covers the event and
 * its aftermath, and after that the next account opens a story of its own.
 */
export const MAX_STORY_DAYS = 7;

/**
 * The most accounts a story Raazi built itself may hold.
 *
 * Every path that grows a story — filing, folding, the inbox's grouping —
 * stops here, and a story past it is taken apart (splitRunaways). Without a
 * ceiling, grouping that links accounts pair by pair chains: A is like B, B
 * like C, and by 17 November 2026 one "story" held 659 accounts — Iran's
 * supreme leader, the Michigan Senate race, California's voter rolls — under
 * the headline of a fiancé profile. The largest real event on this desk
 * draws a few dozen outlets; past this the next account opens a second
 * story, which is untidy, rather than hiding inside the first, which is not
 * visible at all.
 */
export const MAX_STORY_ACCOUNTS = 60;

/** Headline overlap required before the second signal is even consulted.
 *  Low, because the second signal is what decides: "McConnell returns after
 *  months-long absence for crucial vote" shares two words in five with the
 *  wire's headline, and the same three Kentuckians in its lede. */
export const TITLE_FLOOR = 0.34;

/** With this much headline overlap, shared entities are not required. */
export const TITLE_CERTAIN = 0.72;

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
export const MIN_TITLE_WORDS = 3;

export const STOP = new Set([
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

/**
 * Headline words that are the beat rather than the story. "Trump" is in one
 * headline in seven on this desk, and "White House" plus one more word was
 * enough overlap to try a match: on 28 September 2026 the Xi visit, diesel
 * prices and a senator's AI letter were folded into the press-ban story on
 * nothing else. "House" alone stays — the chamber is a story's subject.
 */
const TITLE_BEAT = /\b(white\s+house|donald|trump)(['’]s)?\b/g;

/** The words of a headline that carry its identity. */
export function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(TITLE_BEAT, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem);
}

/** How much a headline word says about which story it is. */
export type TitleWeights = (word: string) => number;

/**
 * Headline words weighed by how rare the week has made them.
 *
 * The list above covers the words that are always the beat on this desk;
 * the rest move with the news. In the week of 22 September 2026 "Iran" and
 * "war" were each in forty story headlines, and "Hassett on Iran war" took in
 * the UN General Assembly, a soldier's death, the Senate's war-powers vote
 * and a Lawfare podcast — every one shared "Iran war", two words of five, and
 * an Iranian name in its opening lines. Cutting common words out does not
 * work either: "ban" was in fifty-seven headlines that week and still named
 * the press ban. So a shared word counts by its rarity (inverse document
 * frequency over the week's story headlines — stories, not articles, so forty
 * outlets' headlines on one event count once): sharing "Iran war" with a
 * headline whose other words are "Hassett" and "act" is little overlap, and
 * sharing "ban", "CNN" and "Politico" with one that says nothing else is all
 * of it. With no week to measure, every word weighs the same.
 */
let weightCache: { at: number; weigh: TitleWeights } | null = null;

export function titleWeights(): TitleWeights {
  if (weightCache && Date.now() - weightCache.at < 10 * 60_000) return weightCache.weigh;
  const titles = db()
    .prepare("SELECT title FROM stories WHERE first_seen >= datetime('now', '-7 days')")
    .all() as { title: string }[];
  const df = new Map<string, number>();
  for (const t of titles) for (const w of new Set(titleWords(t.title))) df.set(w, (df.get(w) ?? 0) + 1);
  const n = titles.length;
  const weigh: TitleWeights = (w) => 1 + Math.log((n + 1) / ((df.get(w) ?? 0) + 1));
  weightCache = { at: Date.now(), weigh };
  return weigh;
}

/**
 * The same word in another form. "Trump says he'll ban CNN…" and "Trump says
 * he's banning CNN…" are one announcement, and without this they shared two
 * words of three and opened two stories. Crude on purpose: it only has to
 * make two headlines' forms of a word meet, never to be a dictionary word.
 */
function stem(w: string): string {
  if (w.length <= 3 || /^\p{N}+$/u.test(w)) return w;
  let s = w;
  if (/ies$/.test(s)) s = s.slice(0, -3) + "y";
  else if (/(ing|ed)$/.test(s) && s.length > 5) s = s.replace(/(ing|ed)$/, "");
  else if (/[^s]s$/.test(s)) s = s.slice(0, -1);
  // banning → bann → ban; a trailing silent e the same way both sides.
  if (/([b-df-hj-np-tv-z])\1$/.test(s) && !/(ss|ll|ff|zz)$/.test(s)) s = s.slice(0, -1);
  return s.replace(/e$/, "");
}

/**
 * Whether two headlines are alike enough to be one story on their own.
 *
 * The overlap has to be high AND both headlines have to have said something:
 * a one- or two-word identity is what a column title or a wire slug leaves
 * behind, and it matches every instalment.
 */
export function titlesAgree(a: string, b: string, weigh?: TitleWeights): boolean {
  const A = new Set(titleWords(a));
  const B = new Set(titleWords(b));
  if (Math.min(A.size, B.size) < MIN_TITLE_WORDS) return false;
  return titleSimilarity(a, b, weigh) >= TITLE_CERTAIN;
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
export const COMMON_NAMES = new Set([
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
export function titleSimilarity(a: string, b: string, weigh: TitleWeights = () => 1): number {
  const A = new Set(titleWords(a));
  const B = new Set(titleWords(b));
  if (A.size === 0 || B.size === 0) return 0;
  const total = (set: Set<string>) => [...set].reduce((sum, w) => sum + weigh(w), 0);
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += weigh(w);
  // Jaccard would punish a long headline paired with a short one, which is the
  // normal shape of a wire report and its rewrite; this asks how much of the
  // *smaller* headline is present in the larger.
  return shared / Math.min(total(A), total(B));
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
          AND s.first_seen >= datetime(?, '-${MAX_STORY_DAYS} days')
          AND (SELECT COUNT(*) FROM story_sources x WHERE x.story_id = s.id) < ${MAX_STORY_ACCOUNTS}
        ORDER BY abs(julianday(s.last_seen) - julianday(?))
        LIMIT 400`
    )
    .all(source.at, source.at, source.at, source.at) as Candidate[];
  // Nearest in time first, not newest. The library opens a hundred and more
  // stories a day, so "the 200 seen most recently" was the last day or so —
  // and an account filed later than it arrived (a re-filing, a slow fetch)
  // was never shown the stories of its own day at all.

  let best: { story: Candidate; score: number } | null = null;
  // Read once, and only if a headline comes close enough to need it.
  let names: Set<string> | undefined;
  const weigh = titleWeights();
  const mine = titleWords(source.title).length;
  for (const story of candidates) {
    const score = titleSimilarity(source.title, story.title, weigh);
    if (score < TITLE_FLOOR) continue;
    if (Math.min(mine, titleWords(story.title).length) < MIN_TITLE_WORDS) {
      // A headline that says almost nothing — a column's title, a wire slug
      // — matches only on entities the pedia knows, which means only once
      // the passages have been read. Names in a lede are not enough here:
      // the instalments of one column all open the same way.
      if (sharedEntities(sourceId, story.id) < MIN_SHARED_ENTITIES) continue;
    } else if (!titlesAgree(source.title, story.title, weigh)) {
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
/**
 * Entities in so many of the week's articles that sharing them says nothing.
 *
 * The entity half of the test used to compare an account with every entity
 * in every account of a story, and on this beat "Donald Trump" and "White
 * House" are in half of them. So a story, once it had twenty accounts,
 * agreed with any headline that shared a word with its own: "Trump says he
 * is banning three media outlets from the White House" took in the Xi
 * summit, the Iran war, a triumphal arch and a comedian — 286 accounts over
 * twelve days by 28 September 2026, which the brief then reported as "a
 * story carried by 282 outlets". The same rule as COMMON_NAMES, measured
 * rather than listed.
 */
const BEAT_SHARE = 0.08;
const BEAT_FLOOR = 6;
let beatCache: { at: number; ids: Set<number> } | null = null;

export function beatEntities(): Set<number> {
  if (beatCache && Date.now() - beatCache.at < 10 * 60_000) return beatCache.ids;
  const rows = db()
    .prepare(
      `SELECT m.entity_id AS id, COUNT(DISTINCT m.source_id) AS n
         FROM live_mentions m JOIN sources s ON s.id = m.source_id
        WHERE COALESCE(s.published_at, s.added_at) >= datetime('now', '-7 days')
        GROUP BY m.entity_id`
    )
    .all() as { id: number; n: number }[];
  const total = (
    db()
      .prepare(
        `SELECT COUNT(DISTINCT m.source_id) AS n
           FROM live_mentions m JOIN sources s ON s.id = m.source_id
          WHERE COALESCE(s.published_at, s.added_at) >= datetime('now', '-7 days')`
      )
      .get() as { n: number }
  ).n;
  const bar = Math.max(BEAT_FLOOR, Math.ceil(total * BEAT_SHARE));
  const ids = new Set(rows.filter((r) => r.n >= bar).map((r) => r.id));
  beatCache = { at: Date.now(), ids };
  return ids;
}

/** For tests, which build a library and ask again within the ten minutes. */
export function forgetBeat(): void {
  beatCache = null;
  weightCache = null;
}

/**
 * Entities an account shares with the opening accounts of a story, the beat
 * left out. The first few accounts only, for the reason storyNames gives: a
 * union across all of them agrees with anything.
 */
function sharedEntities(sourceId: number, storyId: number): number {
  const beat = beatEntities();
  const mine = db()
    .prepare("SELECT DISTINCT entity_id AS id FROM live_mentions WHERE source_id = ?")
    .all(sourceId) as { id: number }[];
  if (!mine.length) return 0;
  const theirs = new Set(
    (
      db()
        .prepare(
          `SELECT DISTINCT m.entity_id AS id FROM live_mentions m
            WHERE m.source_id IN (
              SELECT ss.source_id FROM story_sources ss JOIN sources s ON s.id = ss.source_id
               WHERE ss.story_id = ? ORDER BY COALESCE(s.published_at, s.added_at) LIMIT 3
            )`
        )
        .all(storyId) as { id: number }[]
    ).map((r) => r.id)
  );
  return mine.filter((m) => theirs.has(m.id) && !beat.has(m.id)).length;
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
 * event by the same two-signal rule. Only stories Raazi named itself and
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
  const weigh = titleWeights();
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
      // Opened within the window of each other. Last-seen used to count as
      // well, which let a story that never closed fold in anything recent.
      if (!within(a.first_seen, b.first_seen)) continue;
      const score = titleSimilarity(a.title, b.title, weigh);
      if (score < TITLE_FLOOR) continue;
      if (!titlesAgree(a.title, b.title, weigh) && overlap(namesFor(a.id), namesFor(b.id)) < MIN_SHARED_NAMES) continue;
      if (a.accounts + b.accounts > MAX_STORY_ACCOUNTS) continue;

      // The one with more accounts keeps its name; on a tie, the older.
      const [keep, drop] = b.accounts > a.accounts ? [b, a] : [a, b];
      mergeStories(keep.id, drop.id);
      gone.add(drop.id);
      keep.accounts += drop.accounts;
      // The kept story's names stay its own: adding the folded one's made
      // each fold widen what the next could agree with.
      merged++;
      if (drop.id === a.id) break;
    }
  }
  if (merged) console.log(`[corpus] stories: folded ${merged} duplicate${merged === 1 ? "" : "s"} into the story already running`);
  return merged;
}

/**
 * Whether two stories were opened close enough together to be one event.
 * The inbox's grouping folds stories as well as accounts, and without this
 * one account related to both an old story and a new one joined them.
 */
export function mayFold(a: number, b: number): boolean {
  const rows = db()
    .prepare("SELECT first_seen FROM stories WHERE id IN (?, ?)")
    .all(a, b) as { first_seen: string }[];
  if (rows.length < 2) return true;
  const t = rows.map((r) => new Date(r.first_seen.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(r.first_seen) ? "" : "Z")).getTime());
  return Math.abs(t[0] - t[1]) <= WINDOW_HOURS * 3_600_000;
}

/**
 * Takes apart the stories that grew past one event and files their
 * accounts again, oldest first, under the rules as they are now.
 *
 * A story Raazi named itself whose accounts span more than MAX_STORY_DAYS,
 * or that holds more than MAX_STORY_ACCOUNTS, cannot be one event under the
 * current rules, so it was built by older ones. A story you named or pinned
 * is left alone. Returns how many stories were taken apart and how many
 * accounts were filed again.
 *
 * `inboxOnly` looks only at stories with something still waiting in the
 * inbox, which is what the regroup runs every pass: over every story ever
 * filed the query takes the better part of two minutes.
 */
export function splitRunaways(opts: { inboxOnly?: boolean } = {}): { stories: number; accounts: number } {
  const ids = runawayIds(opts.inboxOnly ?? false);
  const accounts = drain(refileSteps(ids));
  if (ids.length) {
    console.log(`[corpus] stories: took apart ${ids.length} that had grown past one event, filing ${accounts} accounts again`);
  }
  return { stories: ids.length, accounts };
}

/**
 * The same, giving the server's thread back between accounts: the first pass
 * over a library the old rules had piled up files a couple of thousand
 * accounts again, which takes minutes, and Raazi must keep answering meanwhile.
 */
export async function splitRunawaysAsync(opts: { inboxOnly?: boolean } = {}): Promise<{ stories: number; accounts: number }> {
  const ids = runawayIds(opts.inboxOnly ?? false);
  const steps = refileSteps(ids);
  let slice = Date.now();
  let next = steps.next();
  while (!next.done) {
    if (Date.now() - slice > 30) {
      await new Promise((r) => setImmediate(r));
      slice = Date.now();
    }
    next = steps.next();
  }
  if (ids.length) {
    console.log(`[corpus] stories: took apart ${ids.length} that had grown past one event, filing ${next.value} accounts again`);
  }
  return { stories: ids.length, accounts: next.value };
}

function runawayIds(inboxOnly: boolean): number[] {
  const inbox = inboxOnly
    ? `AND s.id IN (SELECT ss2.story_id FROM feed_items i JOIN story_sources ss2 ON ss2.source_id = i.source_id
                    WHERE i.state = 'held' AND i.decided_at IS NULL)`
    : "";
  const runaways = db()
    .prepare(
      `SELECT s.id FROM stories s
         JOIN story_sources ss ON ss.story_id = s.id
         JOIN sources src ON src.id = ss.source_id
        WHERE s.named_by = 'auto' AND s.pinned = 0 ${inbox}
        GROUP BY s.id
       HAVING COUNT(*) > ${MAX_STORY_ACCOUNTS}
           OR julianday(MAX(COALESCE(src.published_at, src.added_at)))
            - julianday(MIN(COALESCE(src.published_at, src.added_at))) > ${MAX_STORY_DAYS}`
    )
    .all() as { id: number }[];
  return runaways.map((r) => r.id);
}

/**
 * Files every account of the stories Raazi opened since a date again, from
 * nothing, oldest first, then folds the duplicates — for when the rules that
 * built them have changed. Stories you named or pinned are left as they are.
 */
export function rebuildStories(since: string): { stories: number; accounts: number } {
  const ids = (
    db()
      .prepare("SELECT id FROM stories WHERE named_by = 'auto' AND pinned = 0 AND first_seen >= ?")
      .all(since) as { id: number }[]
  ).map((r) => r.id);
  // No regroup over the whole span afterwards: its "a name in 8% of the
  // stories is the beat" bar is sized for the 300 stories of a normal pass,
  // and over thousands it lets the beat's names back in. The regroup after
  // the next poll covers the recent days at its usual size.
  return { stories: ids.length, accounts: drain(refileSteps(ids)) };
}

function drain<T>(steps: Generator<void, T>): T {
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/** Dissolves the stories and files their accounts again, oldest first; one step per account. */
function* refileSteps(storyIds: number[]): Generator<void, number> {
  if (!storyIds.length) return 0;
  // Measured now, while the stories it is measured on still exist.
  titleWeights();
  const read = db().prepare(
    `SELECT ss.source_id AS id, COALESCE(s.published_at, s.added_at) AS at FROM story_sources ss
       JOIN sources s ON s.id = ss.source_id WHERE ss.story_id = ?`
  );
  const members = storyIds.flatMap((id) => read.all(id) as { id: number; at: string }[]);
  members.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id - b.id);
  tx(() => {
    const unlink = db().prepare("DELETE FROM story_sources WHERE story_id = ?");
    const drop = db().prepare("DELETE FROM stories WHERE id = ?");
    for (const id of storyIds) {
      unlink.run(id);
      drop.run(id);
    }
  });
  for (const m of members) {
    fileSource(m.id);
    yield;
  }
  return members.length;
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
