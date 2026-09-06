import { db } from "./db";
import { listWatchlist } from "./watchlist";
import { citationOf } from "./queries";
import { formatLocator } from "./chunk";
import { citedIds } from "./markers";
import type { Locator } from "./types";

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

/**
 * Sources that arrived, or were published, inside the window.
 *
 * `kept_at` comes first because a decision is the event that matters once
 * feeds are filtered by hand: an article published on Sunday and kept on
 * Monday is Monday's, both to the week that collects it and to you when you go
 * looking for it. Everything that never went through an inbox — a book, a
 * pasted passage, anything from before the inbox existed — has no kept_at and
 * falls through to the dates it always used.
 */
const IN_WINDOW = `COALESCE(s.kept_at, s.published_at, s.added_at) >= @from
                   AND COALESCE(s.kept_at, s.published_at, s.added_at) < @to
                   AND (s.triage IS NULL OR s.triage = 'kept')`;

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

  /**
   * The watched sections, and why they are topics.
   *
   * They used to be one section per watched thing, entities included, and that
   * is what made a quiet morning read as four developments: an article about
   * the president is evidence about Donald Trump, the Trump administration, the
   * White House and the United States, so the same passage was printed four
   * times under four headings. A topic covers all four in one, and says
   * something a reader can act on — "Trade policy", not "Donald Trump".
   *
   * Entity watches still exist and still do their other work: they decide which
   * entries are kept current first, and the star on an entry is how you say a
   * subject matters. They no longer carve up the brief.
   *
   * A passage is used once. The first section to claim it keeps it, and the
   * rest of the brief — including "everything else" — will not repeat it.
   */
  for (const w of listWatchlist()) {
    let rows: BriefPassage[] = [];

    if (w.kind === "entity") {
      continue;
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

    const fresh = rows.filter((r) => !seen.has(r.mention_id));
    if (fresh.length) {
      for (const r of fresh) seen.add(r.mention_id);
      watched.push({ label: w.label, kind: w.kind, entityId: w.entity_id, passages: fresh });
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
  kind: string;
  body_md: string;
  state: string;
  window_from: string | null;
  window_to: string | null;
  stats_json: string;
  error: string | null;
  /** Which model wrote it, as the provider reported; null for the
   *  "nothing came in" notice or when the call never said. */
  model: string | null;
  created_at: string;
}

export function getBrief(day: string): BriefRow | undefined {
  return db().prepare("SELECT * FROM briefs WHERE day=?").get(day) as BriefRow | undefined;
}

export function latestBrief(): BriefRow | undefined {
  return db().prepare("SELECT * FROM briefs WHERE kind='day' ORDER BY day DESC LIMIT 1").get() as
    | BriefRow
    | undefined;
}

export function listBriefs(limit = 30): BriefRow[] {
  return db()
    .prepare("SELECT * FROM briefs WHERE kind='day' ORDER BY day DESC LIMIT ?")
    .all(limit) as BriefRow[];
}

/** The weekly ones, newest first. Their `day` is the week's Friday, prefixed. */
export function listWeeklyBriefs(limit = 26): BriefRow[] {
  return db()
    .prepare("SELECT * FROM briefs WHERE kind='week' ORDER BY day DESC LIMIT ?")
    .all(limit) as BriefRow[];
}

export interface RenderedCitation {
  id: number;
  quote: string;
  citation: string;
  sourceId: number;
  sourceTitle: string;
  locator: string;
  chunkId: number;
  entityId: number;
  entityName: string;
  outlet: string | null;
  publishedAt: string | null;
  url: string | null;
}

/**
 * The passages a written brief cites, resolved for the popover.
 *
 * Both brief pages need exactly this and nothing else: a marker in the text is
 * only worth having if clicking it opens the passage, and the passage is only
 * worth showing with its outlet, its date and a way through to the entry.
 */
export function citationsFor(bodyMd: string): RenderedCitation[] {
  const ids = [...citedIds(bodyMd ?? "")];
  if (!ids.length) return [];

  const rows = db()
    .prepare(
      `SELECT m.id, m.quote, m.chunk_id, m.source_id, m.entity_id,
              e.canonical_name AS entity_name,
              s.title AS source_title, s.author AS source_author, s.year AS source_year,
              s.outlet, s.published_at, s.url,
              c.locator_json, d.label AS doc_label
         FROM mentions m
         JOIN entities e ON e.id = m.entity_id
         JOIN sources  s ON s.id = m.source_id
         JOIN chunks   c ON c.id = m.chunk_id
    LEFT JOIN documents d ON d.id = c.doc_id
        WHERE m.id IN (${ids.map(() => "?").join(",")})`
    )
    .all(...ids) as {
    id: number;
    quote: string;
    chunk_id: number;
    source_id: number;
    entity_id: number;
    entity_name: string;
    source_title: string;
    source_author: string | null;
    source_year: string | null;
    outlet: string | null;
    published_at: string | null;
    url: string | null;
    locator_json: string;
    doc_label: string | null;
  }[];

  return rows.map((c) => {
    const locator = formatLocator(JSON.parse(c.locator_json) as Locator, c.doc_label);
    return {
      id: c.id,
      quote: c.quote,
      citation: citationOf({
        source_author: c.source_author,
        source_title: c.source_title,
        source_year: c.source_year,
        locator,
      }),
      sourceId: c.source_id,
      sourceTitle: c.source_title,
      locator,
      chunkId: c.chunk_id,
      entityId: c.entity_id,
      entityName: c.entity_name,
      outlet: c.outlet,
      publishedAt: c.published_at,
      url: c.url,
    };
  });
}

export interface KeptArticle {
  source_id: number;
  title: string;
  outlet: string | null;
  author: string | null;
  url: string | null;
  published_at: string | null;
  kept_at: string | null;
  reliability: string | null;
  passages: number;
  story_id: number | null;
  story_title: string | null;
  feed_title: string | null;
}

/**
 * What you kept in a window, whether or not it has been read yet.
 *
 * The week page shows this as it fills, so the brief is never the first time
 * you see what the week contained — and so a Thursday afternoon can tell you
 * what is still waiting to be read before you ask for the write-up.
 */
export function keptBetween(from: Date, to: Date, limit = 300): KeptArticle[] {
  return db()
    .prepare(
      `SELECT s.id AS source_id, s.title, s.outlet, s.author, s.url, s.published_at,
              s.kept_at, s.reliability,
              (SELECT COUNT(*) FROM live_mentions m WHERE m.source_id = s.id) AS passages,
              ss.story_id AS story_id, st.title AS story_title,
              f.title AS feed_title
         FROM sources s
    LEFT JOIN story_sources ss ON ss.source_id = s.id
    LEFT JOIN stories st ON st.id = ss.story_id
    LEFT JOIN feed_items i ON i.source_id = s.id
    LEFT JOIN feeds f ON f.id = i.feed_id
        WHERE s.triage = 'kept' AND s.kept_at >= @from AND s.kept_at < @to
        ORDER BY s.kept_at DESC
        LIMIT @limit`
    )
    .all({ from: from.toISOString(), to: to.toISOString(), limit }) as KeptArticle[];
}

/** Today, in the local calendar, which is the one you live in. */
export function todayKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
