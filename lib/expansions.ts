import { db, tx } from "./db";
import { getConfig } from "./config";
import { createRun, enqueue } from "./queue";
import { getBrief, PASSAGE_COLUMNS, PASSAGE_JOINS, WORTH_READING, type BriefPassage } from "./brief";
import { briefSections, headingKey, type BriefSection } from "./brief-sections";

/**
 * An expanded look at one heading of a brief.
 *
 * A brief gives a topic two or three sentences, which is right for a morning
 * and wrong for the one story you are about to write or present on. Expanding
 * a heading writes that story out properly — where it stands, how it got
 * there, who is saying what — and it does so under the brief's own rule:
 * nothing goes in that a passage in the library does not carry.
 *
 * What an expansion can use that the brief could not is more of the library.
 * The brief had one window and a passage budget per topic; an expansion takes
 * the passages the brief cited under the heading, everything else read out of
 * those same articles, and earlier coverage of the same subjects from the
 * last two months. That last part is the difference between a longer brief
 * and an explanation, and it is found by SQL, not by a model deciding what is
 * related.
 */

export interface Expansion {
  id: number;
  brief_day: string;
  heading: string;
  state: "pending" | "done" | "failed";
  body_md: string;
  error: string | null;
  model: string | null;
  stats_json: string;
  created_at: string;
  updated_at: string;
  /** The run writing it, while one is. */
  run_id: number | null;
}

const COLUMNS = `x.*,
  (SELECT t.run_id FROM tasks t JOIN runs r ON r.id = t.run_id
    WHERE t.kind = 'expand' AND t.state IN ('pending', 'running')
      AND r.state IN ('queued', 'running', 'paused_quota', 'paused_key', 'paused_budget')
      AND json_extract(t.payload_json, '$.expansionId') = x.id
    ORDER BY t.id DESC LIMIT 1) AS run_id`;

export function listExpansions(day: string): Expansion[] {
  return db()
    .prepare(`SELECT ${COLUMNS} FROM brief_expansions x WHERE x.brief_day = ? ORDER BY x.id`)
    .all(day) as Expansion[];
}

export function getExpansion(id: number): Expansion | undefined {
  return db().prepare(`SELECT ${COLUMNS} FROM brief_expansions x WHERE x.id = ?`).get(id) as Expansion | undefined;
}

export function findExpansion(day: string, heading: string): Expansion | undefined {
  return db()
    .prepare(`SELECT ${COLUMNS} FROM brief_expansions x WHERE x.brief_day = ? AND x.heading = ?`)
    .get(day, headingKey(heading)) as Expansion | undefined;
}

/** A request that cannot be honoured, in words for the person who made it. */
export class ExpandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpandError";
  }
}

/** The section under a heading of a finished brief. */
export function sectionOf(day: string, heading: string): BriefSection | undefined {
  const brief = getBrief(day);
  if (!brief || brief.state !== "done" || !brief.body_md) return undefined;
  const key = headingKey(heading);
  return briefSections(brief.body_md).find((s) => s.heading === key);
}

/**
 * Queues an expansion of one heading.
 *
 * One row per heading per brief. Asking for one that is already written
 * returns it as it is unless `force` says to write it again; asking for one
 * that failed, or never finished, simply tries again.
 */
export function requestExpansion(
  day: string,
  heading: string,
  opts: { force?: boolean } = {}
): { expansion: Expansion; runId: number | null; note?: string } {
  const section = sectionOf(day, heading);
  if (!section) {
    throw new ExpandError("That heading is not in the brief for this day — it may have been rewritten.");
  }
  if (!section.mentionIds.length) {
    throw new ExpandError("Nothing under that heading cites a passage, so there is nothing to expand it from.");
  }

  return tx(() => {
    const existing = findExpansion(day, section.heading);
    if (existing?.state === "done" && !opts.force) {
      return { expansion: existing, runId: null, note: "Already expanded. Ask again with force to write it again." };
    }

    let id: number;
    if (existing) {
      db()
        .prepare("UPDATE brief_expansions SET state='pending', error=NULL, updated_at=datetime('now') WHERE id=?")
        .run(existing.id);
      id = existing.id;
    } else {
      id = Number(
        db()
          .prepare("INSERT INTO brief_expansions (brief_day, heading) VALUES (?, ?)")
          .run(day, section.heading).lastInsertRowid
      );
    }

    const runId = createRun({
      kind: "brief",
      label: `Expanding "${section.heading}" from the brief for ${day}`,
      budgetCap: getConfig().defaultBudget,
    });
    enqueue(runId, [{ kind: "expand" as const, payload: { expansionId: id } }]);
    return { expansion: getExpansion(id)!, runId };
  });
}

// ---------------------------------------------------------------------------
// What an expansion is written from.
// ---------------------------------------------------------------------------

/** How far back earlier coverage is looked for, from the end of the brief's window. */
export const EXPAND_LOOKBACK_DAYS = 60;
/** The most passages taken from the cited articles beyond the ones cited. */
export const EXPAND_MAX_ARTICLE_PASSAGES = 120;
/** The most earlier articles, and passages from each. */
export const EXPAND_MAX_BACKGROUND_SOURCES = 10;
export const EXPAND_PER_BACKGROUND_SOURCE = 6;

/**
 * How closely an earlier article has to touch the section to count.
 *
 * Each subject it shares with the section scores by how rare that subject is
 * in this library: log(N / n) scaled to between 0 and 1, where N is the number
 * of articles read and n the number that mention the subject. Relative, not
 * absolute, because rare means something different in a hundred articles and
 * in five thousand. On a library of three thousand, a subject in fifty
 * articles scores about 0.5 and counts on its own; the United States, in half
 * of them, scores under 0.1, and a pile of subjects like that does not add up
 * to a connection — which is what stops every article about Washington from
 * being background to every American story.
 */
export const EXPAND_MIN_SCORE = 0.45;

/** A subject's rarity, 0 (in everything) to 1 (in one article of a large library). */
export function rarity(mentionedIn: number, articles: number): number {
  const total = Math.max(1, articles);
  if (total <= 1) return 1;
  return Math.max(0, Math.log2((total + 1) / (mentionedIn + 1)) / Math.log2(total + 1));
}
/** Being grouped into the same running story is reason enough on its own. */
const STORY_BONUS = 2;

export interface ExpandMaterial {
  day: string;
  section: BriefSection;
  /** The passages the brief cited under the heading. */
  cited: BriefPassage[];
  /** Everything else read out of those same articles. */
  articles: BriefPassage[];
  /** Earlier coverage of the same subjects, oldest first. */
  background: BriefPassage[];
  counts: { cited: number; articles: number; background: number; sources: number; backgroundSources: number };
}

const byTime = (a: BriefPassage, b: BriefPassage) =>
  (a.published_at ?? "").localeCompare(b.published_at ?? "") || a.mention_id - b.mention_id;

/** One row per passage: a source in more than one story would otherwise repeat. */
function once(rows: BriefPassage[]): BriefPassage[] {
  const seen = new Set<number>();
  return rows.filter((r) => (seen.has(r.mention_id) ? false : (seen.add(r.mention_id), true)));
}

export function expansionMaterial(day: string, heading: string): ExpandMaterial | undefined {
  const section = sectionOf(day, heading);
  if (!section || !section.mentionIds.length) return undefined;
  const brief = getBrief(day)!;

  const cited = once(
    db()
      .prepare(
        `SELECT ${PASSAGE_COLUMNS} ${PASSAGE_JOINS}
          WHERE m.id IN (SELECT value FROM json_each(@ids))`
      )
      .all({ ids: JSON.stringify(section.mentionIds) }) as BriefPassage[]
  ).sort(byTime);
  if (!cited.length) return undefined;

  const citedIds = new Set(cited.map((p) => p.mention_id));
  const sourceIds = [...new Set(cited.map((p) => p.source_id))];
  const entityIds = [...new Set(cited.map((p) => p.entity_id))];
  const sources = JSON.stringify(sourceIds);
  const entities = JSON.stringify(entityIds);

  const articles = once(
    db()
      .prepare(
        `SELECT ${PASSAGE_COLUMNS} ${PASSAGE_JOINS}
          WHERE m.source_id IN (SELECT value FROM json_each(@sources)) AND ${WORTH_READING}
          ORDER BY COALESCE(s.published_at, s.added_at), m.id
          LIMIT @limit`
      )
      .all({ sources, limit: EXPAND_MAX_ARTICLE_PASSAGES + citedIds.size }) as BriefPassage[]
  )
    .filter((p) => !citedIds.has(p.mention_id))
    .slice(0, EXPAND_MAX_ARTICLE_PASSAGES)
    .sort(byTime);

  // Earlier coverage: what you kept or filed in the two months before the
  // brief closed, never anything held or discarded.
  const to = brief.window_to ?? new Date().toISOString();
  const from = new Date(new Date(to).getTime() - EXPAND_LOOKBACK_DAYS * 86_400_000).toISOString();
  const eligible = `(s.triage IS NULL OR s.triage IN ('kept', 'filed'))
    AND datetime(COALESCE(s.kept_at, s.published_at, s.added_at)) >= datetime(@from)
    AND datetime(COALESCE(s.kept_at, s.published_at, s.added_at)) < datetime(@to)
    AND s.id NOT IN (SELECT value FROM json_each(@sources))`;

  const spread = db()
    .prepare(
      `SELECT m.entity_id, COUNT(DISTINCT m.source_id) AS n FROM live_mentions m
        WHERE m.entity_id IN (SELECT value FROM json_each(@entities))
        GROUP BY m.entity_id`
    )
    .all({ entities }) as { entity_id: number; n: number }[];
  const articleCount = (
    db().prepare("SELECT COUNT(DISTINCT source_id) AS n FROM live_mentions").get() as { n: number }
  ).n;
  const weight = new Map(spread.map((r) => [r.entity_id, rarity(r.n, articleCount)]));

  const shared = db()
    .prepare(
      `SELECT DISTINCT m.source_id, m.entity_id
         FROM live_mentions m JOIN sources s ON s.id = m.source_id
        WHERE m.entity_id IN (SELECT value FROM json_each(@entities)) AND ${eligible}`
    )
    .all({ entities, sources, from, to }) as { source_id: number; entity_id: number }[];

  const storyMates = new Set(
    (
      db()
        .prepare(
          `SELECT DISTINCT other.source_id
             FROM story_sources mine
             JOIN story_sources other ON other.story_id = mine.story_id
             JOIN sources s ON s.id = other.source_id
            WHERE mine.source_id IN (SELECT value FROM json_each(@sources)) AND ${eligible}`
        )
        .all({ sources, from, to }) as { source_id: number }[]
    ).map((r) => r.source_id)
  );

  const score = new Map<number, number>();
  for (const r of shared) score.set(r.source_id, (score.get(r.source_id) ?? 0) + (weight.get(r.entity_id) ?? 0));
  for (const id of storyMates) score.set(id, (score.get(id) ?? 0) + STORY_BONUS);

  const chosen = [...score.entries()]
    .filter(([id, s]) => s >= EXPAND_MIN_SCORE || storyMates.has(id))
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])
    .slice(0, EXPAND_MAX_BACKGROUND_SOURCES)
    .map(([id]) => id);

  // From an article that shares subjects, the passages about those subjects;
  // from one in the same running story, its passages whatever they are about.
  const fromSource = db().prepare(
    `SELECT ${PASSAGE_COLUMNS} ${PASSAGE_JOINS}
      WHERE m.source_id = @source AND ${WORTH_READING}
        AND (@mate = 1 OR m.entity_id IN (SELECT value FROM json_each(@entities)))
      ORDER BY m.id
      LIMIT @limit`
  );
  const background = once(
    chosen.flatMap(
      (id) =>
        fromSource.all({
          source: id,
          mate: storyMates.has(id) ? 1 : 0,
          entities,
          limit: EXPAND_PER_BACKGROUND_SOURCE,
        }) as BriefPassage[]
    )
  ).sort(byTime);

  return {
    day,
    section,
    cited,
    articles,
    background,
    counts: {
      cited: cited.length,
      articles: articles.length,
      background: background.length,
      sources: sourceIds.length,
      backgroundSources: new Set(background.map((p) => p.source_id)).size,
    },
  };
}
