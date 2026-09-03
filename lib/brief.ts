import { db } from "./db";
import { listWatchlist } from "./watchlist";

/**
 * What the brief is made of.
 *
 * Deliberately all SQL. The brief is not a model reading this morning's
 * articles and telling you about them — that is a summary of a summary, and
 * nothing in it can be checked. It is a query: which passages arrived in this
 * window, about the people and topics you follow, from which outlets, and what
 * did they say. The writing call at the end turns those rows into prose under
 * the same citation rules as an entry, and cannot introduce anything the rows
 * do not carry.
 *
 * Everything below is scoped by publication time where a source has one and by
 * arrival time where it does not, so a book added on Tuesday does not turn up
 * in Tuesday's brief as news.
 */

export interface BriefPassage {
  mention_id: number;
  quote: string;
  claim: string | null;
  context: string | null;
  attribution: string | null;
  claim_kind: string | null;
  entity_id: number;
  entity: string;
  entity_type: string;
  source_id: number;
  source_title: string;
  outlet: string | null;
  author: string | null;
  published_at: string | null;
  reliability: string | null;
  story_id: number | null;
  story_title: string | null;
}

export interface BriefStory {
  id: number;
  title: string;
  accounts: number;
  outlets: string[];
  first_seen: string;
  passages: number;
}

export interface BriefMaterial {
  from: string;
  to: string;
  watched: { label: string; kind: string; entityId: number | null; passages: BriefPassage[] }[];
  stories: BriefStory[];
  other: BriefPassage[];
  contradictions: {
    id: number;
    entity: string;
    claim_a: string;
    claim_b: string;
    title_a: string | null;
    title_b: string | null;
  }[];
  revised: { entity_id: number; entity: string; changelog: string | null; updated_at: string }[];
  problems: { title: string; note: string | null; feed: string }[];
  counts: { sources: number; passages: number; entities: number; stories: number };
}

const PASSAGE_COLUMNS = `
  m.id AS mention_id, m.quote, m.claim, m.context, m.attribution, m.claim_kind,
  e.id AS entity_id, e.canonical_name AS entity, e.type AS entity_type,
  s.id AS source_id, s.title AS source_title, s.outlet, s.author, s.published_at, s.reliability,
  st.story_id AS story_id, story.title AS story_title`;

const PASSAGE_JOINS = `
  FROM live_mentions m
  JOIN entities e ON e.id = m.entity_id AND e.merged_into IS NULL
  JOIN sources  s ON s.id = m.source_id
  LEFT JOIN story_sources st ON st.source_id = s.id
  LEFT JOIN stories story ON story.id = st.story_id`;

/** Sources that arrived, or were published, inside the window. */
const IN_WINDOW = `COALESCE(s.published_at, s.added_at) >= @from AND COALESCE(s.published_at, s.added_at) < @to`;

/**
 * The evidence a passage needs to be worth putting in front of you.
 *
 * A quote with no claim and no context is usually the name-matching sweep
 * finding a mention in a sentence about something else; it belongs in the
 * pedia and not in a brief.
 */
const WORTH_READING = `(m.claim IS NOT NULL OR m.context IS NOT NULL)`;

export function gather(from: Date, to: Date, opts: { perWatch?: number; maxOther?: number } = {}): BriefMaterial {
  const params = { from: from.toISOString(), to: to.toISOString() };
  const perWatch = opts.perWatch ?? 12;

  const watched: BriefMaterial["watched"] = [];
  const seen = new Set<number>();

  for (const w of listWatchlist()) {
    let rows: BriefPassage[] = [];

    if (w.kind === "entity" && w.entity_id) {
      rows = db()
        .prepare(
          `SELECT ${PASSAGE_COLUMNS} ${PASSAGE_JOINS}
            WHERE m.entity_id = @entityId AND ${IN_WINDOW} AND ${WORTH_READING}
            ORDER BY COALESCE(s.published_at, s.added_at) DESC, m.id DESC
            LIMIT @limit`
        )
        .all({ ...params, entityId: w.entity_id, limit: perWatch }) as BriefPassage[];
    } else if (w.kind === "topic" && w.tag_id) {
      rows = db()
        .prepare(
          `SELECT ${PASSAGE_COLUMNS} ${PASSAGE_JOINS}
             JOIN source_tags stg ON stg.source_id = s.id AND stg.tag_id = @tagId
            WHERE ${IN_WINDOW} AND ${WORTH_READING}
            ORDER BY COALESCE(s.published_at, s.added_at) DESC, m.id DESC
            LIMIT @limit`
        )
        .all({ ...params, tagId: w.tag_id, limit: perWatch }) as BriefPassage[];
    } else if (w.phrase) {
      try {
        rows = db()
          .prepare(
            `SELECT ${PASSAGE_COLUMNS} ${PASSAGE_JOINS}
              WHERE m.chunk_id IN (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH @match)
                AND ${IN_WINDOW} AND ${WORTH_READING}
              ORDER BY COALESCE(s.published_at, s.added_at) DESC, m.id DESC
              LIMIT @limit`
          )
          .all({ ...params, match: `"${w.phrase.replace(/"/g, "")}"`, limit: perWatch }) as BriefPassage[];
      } catch {
        rows = [];
      }
    }

    if (rows.length) {
      for (const r of rows) seen.add(r.mention_id);
      watched.push({ label: w.label, kind: w.kind, entityId: w.entity_id, passages: rows });
    }
  }

  // Everything else that arrived, so a brief is still useful before you have
  // built a watchlist — and so something important that is not on it can still
  // reach you. Ranked by how well documented the entity is, which is a decent
  // proxy for "this is one of your subjects" without asking.
  const other = (
    db()
      .prepare(
        `SELECT ${PASSAGE_COLUMNS},
                (SELECT COUNT(*) FROM live_mentions mm WHERE mm.entity_id = e.id) AS weight
         ${PASSAGE_JOINS}
          WHERE ${IN_WINDOW} AND ${WORTH_READING}
          ORDER BY weight DESC, COALESCE(s.published_at, s.added_at) DESC
          LIMIT @limit`
      )
      .all({ ...params, limit: (opts.maxOther ?? 60) + seen.size }) as (BriefPassage & { weight: number })[]
  )
    .filter((r) => !seen.has(r.mention_id))
    .slice(0, opts.maxOther ?? 60);

  const stories = (
    db()
      .prepare(
        `SELECT s.id, s.title, s.first_seen,
                (SELECT COUNT(*) FROM story_sources ss WHERE ss.story_id=s.id) AS accounts,
                (SELECT group_concat(DISTINCT COALESCE(src.outlet, src.publisher, src.title))
                   FROM story_sources ss JOIN sources src ON src.id=ss.source_id
                  WHERE ss.story_id=s.id) AS outlets,
                (SELECT COUNT(*) FROM story_sources ss
                   JOIN live_mentions m ON m.source_id = ss.source_id
                  WHERE ss.story_id=s.id) AS passages
           FROM stories s
          WHERE s.last_seen >= @from AND s.last_seen < @to
          ORDER BY accounts DESC, s.last_seen DESC
          LIMIT 25`
      )
      .all(params) as (Omit<BriefStory, "outlets"> & { outlets: string | null })[]
  ).map((s) => ({ ...s, outlets: (s.outlets ?? "").split(",").filter(Boolean) }));

  const contradictions = db()
    .prepare(
      `SELECT c.id, e.canonical_name AS entity, c.claim_a, c.claim_b,
              sa.title AS title_a, sb.title AS title_b
         FROM contradictions c
         JOIN entities e ON e.id = c.entity_id AND e.merged_into IS NULL
    LEFT JOIN sources sa ON sa.id = c.source_a
    LEFT JOIN sources sb ON sb.id = c.source_b
        WHERE c.resolved = 0 AND c.created_at >= @from AND c.created_at < @to
        ORDER BY c.id DESC LIMIT 20`
    )
    .all(params) as BriefMaterial["contradictions"];

  const revised = db()
    .prepare(
      `SELECT r.entity_id, e.canonical_name AS entity, r.changelog_md AS changelog, r.created_at AS updated_at
         FROM entry_revisions r
         JOIN entities e ON e.id = r.entity_id AND e.merged_into IS NULL
        WHERE r.created_at >= @from AND r.created_at < @to AND r.changelog_md IS NOT NULL
        ORDER BY r.id DESC LIMIT 25`
    )
    .all(params) as BriefMaterial["revised"];

  const problems = db()
    .prepare(
      `SELECT i.title, i.note, f.title AS feed
         FROM feed_items i JOIN feeds f ON f.id = i.feed_id
        WHERE i.state = 'failed' AND i.seen_at >= @from AND i.seen_at < @to
        ORDER BY i.id DESC LIMIT 15`
    )
    .all(params) as BriefMaterial["problems"];

  const counts = db()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sources s WHERE ${IN_WINDOW}) AS sources,
         (SELECT COUNT(*) FROM live_mentions m JOIN sources s ON s.id=m.source_id WHERE ${IN_WINDOW}) AS passages,
         (SELECT COUNT(DISTINCT m.entity_id) FROM live_mentions m JOIN sources s ON s.id=m.source_id WHERE ${IN_WINDOW}) AS entities,
         (SELECT COUNT(*) FROM stories st WHERE st.first_seen >= @from AND st.first_seen < @to) AS stories`
    )
    .get(params) as BriefMaterial["counts"];

  return { from: params.from, to: params.to, watched, stories, other, contradictions, revised, problems, counts };
}

/** Whether there is enough here to be worth a brief at all. */
export function hasMaterial(m: BriefMaterial): boolean {
  return (
    m.watched.some((w) => w.passages.length > 0) ||
    m.other.length > 0 ||
    m.stories.length > 0 ||
    m.contradictions.length > 0
  );
}

export interface BriefRow {
  id: number;
  day: string;
  body_md: string;
  state: string;
  window_from: string | null;
  window_to: string | null;
  stats_json: string;
  error: string | null;
  created_at: string;
}

export function getBrief(day: string): BriefRow | undefined {
  return db().prepare("SELECT * FROM briefs WHERE day=?").get(day) as BriefRow | undefined;
}

export function latestBrief(): BriefRow | undefined {
  return db().prepare("SELECT * FROM briefs ORDER BY day DESC LIMIT 1").get() as BriefRow | undefined;
}

export function listBriefs(limit = 30): BriefRow[] {
  return db().prepare("SELECT * FROM briefs ORDER BY day DESC LIMIT ?").all(limit) as BriefRow[];
}

/** Today, in the local calendar, which is the one you live in. */
export function todayKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
