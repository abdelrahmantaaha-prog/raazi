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

/** Headline overlap required before entities are even consulted. */
const TITLE_FLOOR = 0.42;

/** With this much headline overlap, shared entities are not required. */
const TITLE_CERTAIN = 0.72;

/** Shared known entities required at the lower headline threshold. */
const MIN_SHARED_ENTITIES = 2;

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "in", "on", "at", "to", "for", "with", "by",
  "from", "as", "is", "are", "was", "were", "be", "been", "will", "would", "could", "should",
  "says", "say", "said", "after", "over", "amid", "new", "how", "why", "what", "who",
  "his", "her", "its", "their", "this", "that", "these", "those", "more", "than", "into",
]);

/** The words of a headline that carry its identity. */
export function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
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
  for (const story of candidates) {
    const score = titleSimilarity(source.title, story.title);
    if (score < TITLE_FLOOR) continue;
    if (score < TITLE_CERTAIN && sharedEntities(sourceId, story.id) < MIN_SHARED_ENTITIES) continue;
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
