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

/** Where a passage's dated events fall against the brief's window. */
export type PassageWhen = "within" | "ahead" | "before" | "undated";

export interface DatedEvent {
  iso: string | null;
  text: string | null;
  precision: string | null;
  summary: string;
  when: PassageWhen;
}

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
  /**
   * The events extraction dated from this passage, and where each falls
   * against the window. Filled by `gather`; rows read elsewhere by the same
   * column list will not carry it, and the renderer says nothing then.
   */
  dated?: DatedEvent[];
  /**
   * The passage's own place in time: "within" when something in it happened
   * in the window, "ahead" when it names something still to come, "before"
   * when everything it dates is older than the window — background the
   * article was reminding its readers of, which the writer must not report
   * as news — and "undated" when extraction fixed no date at all.
   */
  when?: PassageWhen;
}

export interface BriefStory {
  id: number;
  title: string;
  /** Every account grouped into it, kept or not: how widely it was carried. */
  accounts: number;
  /** The accounts you actually kept in this window — the ones with passages. */
  kept: number;
  outlets: string[];
  first_seen: string;
  passages: number;
}

export interface BriefSection {
  label: string;
  kind: string;
  entityId: number | null;
  /** How many kept articles were filed under this topic in the window, used or not. */
  sources: number;
  passages: BriefPassage[];
}

export interface BriefMaterial {
  from: string;
  to: string;
  watched: BriefSection[];
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

export const PASSAGE_COLUMNS = `
  m.id AS mention_id, m.quote, m.claim, m.context, m.attribution, m.claim_kind,
  e.id AS entity_id, e.canonical_name AS entity, e.type AS entity_type,
  s.id AS source_id, s.title AS source_title, s.outlet, s.author, s.published_at, s.reliability,
  st.story_id AS story_id, story.title AS story_title`;

export const PASSAGE_JOINS = `
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
export const WORTH_READING = `(m.claim IS NOT NULL OR m.context IS NOT NULL)`;

/**
 * How many passages one article may contribute to one heading.
 *
 * The 15 September brief is why this exists. A topic took its twelve newest
 * passages, newest first, so every heading was the last one or two articles
 * filed under it: the whole of "Elections" was the tail of a 105-passage
 * think-tank paper, credits included ("web development by Martin Tenev"),
 * while the Supreme Court's mail-ballot ruling, carried by thirty outlets
 * that morning, appeared under no heading at all. A cap per article, filled
 * round-robin across the articles that matter most, is what makes a heading
 * read as the day on that beat rather than as one piece from it.
 */
export const PER_SOURCE_CAP = 4;

/** And in "Also arrived", where one line per article is the whole point. */
const OTHER_PER_SOURCE_CAP = 2;
/** So one much-named subject does not fill the section by himself. */
const OTHER_PER_ENTITY_CAP = 3;

interface Row extends BriefPassage {
  confidence: number;
  /** Accounts in this passage's story, kept or not: how widely it was carried. */
  accounts: number;
}

/**
 * Which of a source's topics it is filed under in the brief.
 *
 * A source is tagged on more than one axis, "Iran; Trump administration;
 * US-Iran War", and the brief prints each passage once, so one heading has
 * to claim it. Headings used to claim in order of how much they had arrived,
 * broadest first, which is how a report on munitions shortages in the Iran
 * war ended up under "Trump administration" and a Canadian investment
 * summit under "Economics". The most specific heading claims instead: a
 * running story before a region, a region before a theme, an
 * administration last of all, because an administration's name is on
 * everything it does. Ties go to the tag with fewer sources in the library.
 */
const FACET_RANK: Record<string, number> = { story: 0, region: 1, theme: 2, actor: 4 };

export function facetOf(description: string | null | undefined): string | null {
  const m = /^\s*(story|region|theme|actor)\s*:/i.exec(description ?? "");
  return m ? m[1].toLowerCase() : null;
}

function specificity(tag: { description: string | null; sources: number }): [number, number] {
  const facet = facetOf(tag.description);
  return [facet ? FACET_RANK[facet] : 3, tag.sources];
}

/** Where a sortable date falls against a window, at the precision it carries. */
export function whenOf(iso: string | null | undefined, from: string, to: string): PassageWhen {
  if (!iso) return "undated";
  if (/^--/.test(iso)) return "undated";
  const width = iso.length; // 4, 7 or 10
  const lo = from.slice(0, width);
  const hi = to.slice(0, width);
  if (iso < lo) return "before";
  if (iso > hi) return "ahead";
  return "within";
}

/** Attaches every dated event to the passage it came from, and settles the passage's own tense. */
function attachDates(rows: Row[], from: string, to: string): void {
  if (!rows.length) return;
  const byMention = new Map<number, Row>();
  for (const r of rows) {
    r.dated = [];
    byMention.set(r.mention_id, r);
  }
  const ids = [...byMention.keys()];
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    const events = db()
      .prepare(
        `SELECT mention_id, date_iso, date_text, precision, summary
           FROM events WHERE mention_id IN (${slice.map(() => "?").join(",")})
          ORDER BY id`
      )
      .all(...slice) as {
      mention_id: number;
      date_iso: string | null;
      date_text: string | null;
      precision: string | null;
      summary: string;
    }[];
    for (const ev of events) {
      byMention.get(ev.mention_id)?.dated?.push({
        iso: ev.date_iso,
        text: ev.date_text,
        precision: ev.precision,
        summary: ev.summary,
        when: whenOf(ev.date_iso, from, to),
      });
    }
  }
  for (const r of rows) {
    const whens = new Set((r.dated ?? []).map((d) => d.when));
    r.when = whens.has("within") ? "within" : whens.has("ahead") ? "ahead" : whens.has("before") ? "before" : "undated";
  }
}

/** Background last, then the surer reading, then document order: the lede first. */
const WHEN_RANK: Record<PassageWhen, number> = { within: 0, ahead: 1, undated: 2, before: 3 };
function byUsefulness(a: Row, b: Row): number {
  return (
    WHEN_RANK[a.when ?? "undated"] - WHEN_RANK[b.when ?? "undated"] ||
    b.confidence - a.confidence ||
    a.mention_id - b.mention_id
  );
}

/**
 * Takes passages from a ranked list of sources, one from each in turn,
 * until the budget is spent or every source has given its cap. Round-robin
 * rather than source by source so the fourth article on a beat still gets a
 * line when the first three were long. Returns the passages grouped by
 * source, in source order.
 */
export function roundRobin<T>(sources: T[][], budget: number, cap: number): T[] {
  const taken: T[][] = sources.map(() => []);
  let left = budget;
  for (let round = 0; round < cap && left > 0; round++) {
    for (let i = 0; i < sources.length && left > 0; i++) {
      const next = sources[i][round];
      if (next === undefined) continue;
      taken[i].push(next);
      left--;
    }
  }
  return taken.flat();
}

export function gather(
  from: Date,
  to: Date,
  opts: { perWatch?: number; maxOther?: number; perSource?: number } = {}
): BriefMaterial {
  const params = { from: from.toISOString(), to: to.toISOString() };
  const perWatch = opts.perWatch ?? 16;
  const perSource = opts.perSource ?? PER_SOURCE_CAP;
  const maxOther = opts.maxOther ?? 60;

  /**
   * The watched sections, and why they are topics.
   *
   * They used to be one section per watched thing, entities included, and that
   * is what made a quiet morning read as four developments: an article about
   * the president is evidence about Donald Trump, the Trump administration, the
   * White House and the United States, so the same passage was printed four
   * times under four headings. A topic covers all four in one, and says
   * something a reader can act on: "Trade policy", not "Donald Trump".
   *
   * Entity watches still exist and still do their other work: they decide which
   * entries are kept current first, and the star on an entry is how you say a
   * subject matters. They no longer carve up the brief.
   *
   * A passage is used once, and so is an article: it is filed under the most
   * specific topic it carries, and the rest of the brief, "everything else"
   * included, will not repeat it.
   */
  const watches = listWatchlist().filter((w) => w.kind !== "entity");
  const topicWatches = watches.filter((w) => w.kind === "topic" && w.tag_id);
  const tagIds = topicWatches.map((w) => w.tag_id as number);

  const tagInfo = new Map<number, { description: string | null; sources: number }>();
  if (tagIds.length) {
    for (const t of db()
      .prepare(
        `SELECT t.id, t.description, (SELECT COUNT(*) FROM source_tags st WHERE st.tag_id = t.id) AS sources
           FROM tags t WHERE t.id IN (${tagIds.map(() => "?").join(",")})`
      )
      .all(...tagIds) as { id: number; description: string | null; sources: number }[]) {
      tagInfo.set(t.id, { description: t.description, sources: t.sources });
    }
  }
  const order = new Map(tagIds.map((id, i) => [id, i]));
  const moreSpecific = (a: number, b: number) => {
    const [fa, na] = specificity(tagInfo.get(a) ?? { description: null, sources: 0 });
    const [fb, nb] = specificity(tagInfo.get(b) ?? { description: null, sources: 0 });
    return fa - fb || na - nb || (order.get(a) ?? 0) - (order.get(b) ?? 0);
  };

  // Every kept source in the window that carries a watched topic, filed
  // under the one topic that claims it.
  const filedUnder = new Map<number, number>(); // source -> tag
  if (tagIds.length) {
    const rows = db()
      .prepare(
        `SELECT s.id AS source_id, st.tag_id
           FROM sources s JOIN source_tags st ON st.source_id = s.id
          WHERE ${IN_WINDOW} AND st.tag_id IN (${tagIds.map((id) => Number(id)).join(",")})`
      )
      .all(params) as { source_id: number; tag_id: number }[];
    const options = new Map<number, number[]>();
    for (const r of rows) options.set(r.source_id, [...(options.get(r.source_id) ?? []), r.tag_id]);
    for (const [sourceId, tags] of options) filedUnder.set(sourceId, [...tags].sort(moreSpecific)[0]);
  }

  // All the readable passages of those sources, once, with the width of
  // their story alongside: how many outlets carried the same event is the
  // best cheap signal of what mattered that morning.
  const passagesOf = new Map<number, Row[]>();
  const readRows = (ids: number[]): Row[] =>
    ids.length
      ? (db()
          .prepare(
            `SELECT ${PASSAGE_COLUMNS}, m.confidence,
                    (SELECT COUNT(*) FROM story_sources x WHERE x.story_id = st.story_id) AS accounts
             ${PASSAGE_JOINS}
              WHERE s.id IN (${ids.map(() => "?").join(",")}) AND ${WORTH_READING}
              ORDER BY m.id`
          )
          .all(...ids) as Row[])
      : [];
  const load = (ids: number[]) => {
    const fresh = ids.filter((id) => !passagesOf.has(id));
    if (!fresh.length) return;
    const rows = readRows(fresh);
    attachDates(rows, params.from, params.to);
    for (const id of fresh) passagesOf.set(id, []);
    for (const r of rows) passagesOf.get(r.source_id)!.push(r);
    for (const id of fresh) passagesOf.get(id)!.sort(byUsefulness);
  };
  load([...filedUnder.keys()]);

  const seen = new Set<number>();
  const usedSources = new Set<number>();
  const watched: BriefSection[] = [];

  const rankSources = (ids: number[]): number[] =>
    ids
      .filter((id) => (passagesOf.get(id) ?? []).length > 0)
      .sort((a, b) => {
        const pa = passagesOf.get(a)![0];
        const pb = passagesOf.get(b)![0];
        return (
          (pb.accounts ?? 0) - (pa.accounts ?? 0) ||
          String(pb.published_at ?? "").localeCompare(String(pa.published_at ?? "")) ||
          a - b
        );
      });

  // A heading's budget grows with the articles under it, to a point: a beat
  // with nineteen articles is not told in sixteen one-line passages.
  const budgetFor = (articles: number) => Math.min(2 * perWatch, Math.max(perWatch, 2 * articles));

  for (const w of topicWatches) {
    const mine = rankSources([...filedUnder.keys()].filter((id) => filedUnder.get(id) === w.tag_id));
    if (!mine.length) continue;
    const picked = roundRobin(
      mine.map((id) => passagesOf.get(id)!.filter((r) => !seen.has(r.mention_id))),
      budgetFor(mine.length),
      perSource
    );
    if (!picked.length) continue;
    for (const r of picked) {
      seen.add(r.mention_id);
      usedSources.add(r.source_id);
    }
    watched.push({ label: w.label, kind: w.kind, entityId: w.entity_id, sources: mine.length, passages: picked });
  }

  // A phrase watch is answered by full-text search over the passages of
  // articles no topic has claimed, under the same cap per article.
  for (const w of watches) {
    if (w.kind !== "phrase" || !w.phrase) continue;
    let rows: Row[] = [];
    try {
      rows = db()
        .prepare(
          `SELECT ${PASSAGE_COLUMNS}, m.confidence,
                  (SELECT COUNT(*) FROM story_sources x WHERE x.story_id = st.story_id) AS accounts
           ${PASSAGE_JOINS}
            WHERE m.chunk_id IN (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH @match)
              AND ${IN_WINDOW} AND ${WORTH_READING}
            ORDER BY m.id`
        )
        .all({ ...params, match: `"${w.phrase.replace(/"/g, "")}"` }) as Row[];
    } catch {
      rows = [];
    }
    rows = rows.filter((r) => !seen.has(r.mention_id) && !filedUnder.has(r.source_id));
    if (!rows.length) continue;
    attachDates(rows, params.from, params.to);
    const bySource = new Map<number, Row[]>();
    for (const r of rows) bySource.set(r.source_id, [...(bySource.get(r.source_id) ?? []), r]);
    for (const list of bySource.values()) list.sort(byUsefulness);
    const ranked = [...bySource.values()].sort((a, b) => (b[0].accounts ?? 0) - (a[0].accounts ?? 0));
    const picked = roundRobin(ranked, perWatch, perSource);
    for (const r of picked) {
      seen.add(r.mention_id);
      usedSources.add(r.source_id);
    }
    watched.push({ label: w.label, kind: w.kind, entityId: w.entity_id, sources: bySource.size, passages: picked });
  }

  // The fullest sections first: the shape of the morning, not the order of
  // the watchlist.
  watched.sort(
    (a, b) => b.sources - a.sources || b.passages.length - a.passages.length || a.label.localeCompare(b.label)
  );

  /**
   * Everything else that arrived, one or two lines an article: what no topic
   * claimed, and what a topic claimed but had no room for. Ranked by how
   * widely the story was carried, then by when it came in. It used to rank
   * by how much the pedia already knew about the passage's subject, which
   * meant sixty lines that each began "Donald Trump". A passage that only
   * dates something older than the window is background, and background
   * has no line here.
   */
  const unfiled = (
    db()
      .prepare(
        `SELECT s.id FROM sources s
          WHERE ${IN_WINDOW}
            AND EXISTS (SELECT 1 FROM live_mentions m WHERE m.source_id = s.id AND ${WORTH_READING})`
      )
      .all(params) as { id: number }[]
  )
    .map((r) => r.id)
    .filter((id) => !usedSources.has(id));
  load(unfiled);
  const perEntity = new Map<number, number>();
  const other: BriefPassage[] = [];
  const leftovers = rankSources(unfiled).map((id) =>
    passagesOf.get(id)!.filter((r) => !seen.has(r.mention_id) && r.when !== "before")
  );
  for (const r of roundRobin(leftovers, maxOther * 2, OTHER_PER_SOURCE_CAP)) {
    if (other.length >= maxOther) break;
    const n = perEntity.get(r.entity_id) ?? 0;
    if (n >= OTHER_PER_ENTITY_CAP) continue;
    perEntity.set(r.entity_id, n + 1);
    seen.add(r.mention_id);
    other.push(r);
  }

  /**
   * Running stories: only the ones you kept an account of. A story of
   * thirty-four accounts of which you kept five is five articles' worth of
   * passages and thirty-four outlets' worth of attention, and the writer is
   * told both. One you kept none of is not in your library and not in your
   * brief, however many outlets carried it.
   */
  const stories = (
    db()
      .prepare(
        `SELECT s.id, s.title, s.first_seen,
                (SELECT COUNT(*) FROM story_sources ss WHERE ss.story_id=s.id) AS accounts,
                (SELECT COUNT(*) FROM story_sources ss JOIN sources src ON src.id = ss.source_id
                  WHERE ss.story_id=s.id AND src.triage = 'kept'
                    AND COALESCE(src.kept_at, src.published_at, src.added_at) >= @from
                    AND COALESCE(src.kept_at, src.published_at, src.added_at) < @to) AS kept,
                (SELECT group_concat(DISTINCT COALESCE(src.outlet, src.publisher, src.title))
                   FROM story_sources ss JOIN sources src ON src.id=ss.source_id
                  WHERE ss.story_id=s.id) AS outlets,
                (SELECT COUNT(*) FROM story_sources ss
                   JOIN live_mentions m ON m.source_id = ss.source_id
                  WHERE ss.story_id=s.id) AS passages
           FROM stories s
          WHERE s.last_seen >= @from AND s.last_seen < @to
            AND kept > 0
          ORDER BY kept DESC, accounts DESC, s.last_seen DESC
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

  // Stories are counted as the ones your kept articles belong to; the
  // thousand opened by every wire item the inbox showed you are not news
  // you read.
  const counts = db()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sources s WHERE ${IN_WINDOW}) AS sources,
         (SELECT COUNT(*) FROM live_mentions m JOIN sources s ON s.id=m.source_id WHERE ${IN_WINDOW}) AS passages,
         (SELECT COUNT(DISTINCT m.entity_id) FROM live_mentions m JOIN sources s ON s.id=m.source_id WHERE ${IN_WINDOW}) AS entities,
         (SELECT COUNT(DISTINCT ss.story_id) FROM story_sources ss JOIN sources s ON s.id = ss.source_id WHERE ${IN_WINDOW}) AS stories`
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

/**
 * Where the last daily brief stopped reading, if there was one.
 *
 * A brief covers the hours since the one before it rather than a fixed day,
 * because a Friday off must not cost you Friday's reading: Monday's brief
 * opens where Thursday's closed, and everything kept in between is in it.
 *
 * Only finished daily briefs count, and only ones dated before the day being
 * written — so rewriting today's brief still looks back past today's own row
 * rather than starting where it already ended, which would brief on nothing.
 */
export function coveredThrough(beforeDay: string): Date | undefined {
  const row = db()
    .prepare(
      `SELECT window_to FROM briefs
        WHERE kind='day' AND state='done' AND window_to IS NOT NULL AND day < ?
        ORDER BY day DESC LIMIT 1`
    )
    .get(beforeDay) as { window_to: string } | undefined;
  if (!row) return undefined;
  const d = new Date(row.window_to);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** The furthest back a brief will reach when days have been missed. A
 *  fortnight away should not produce one brief covering a fortnight. */
export const MAX_BRIEF_LOOKBACK_DAYS = 14;

/**
 * When a day's brief starts reading.
 *
 * The configured window is a minimum rather than the rule: whatever the last
 * brief did not reach is this one's to cover. Take Friday off and Monday's
 * brief opens where Thursday's closed, so nothing you kept goes unbriefed.
 * The minimum still holds the other way, so a brief rewritten twice in one
 * morning looks back the configured hours rather than at the twenty minutes
 * since the last attempt.
 */
export function dayWindowFrom(to: Date, hours: number, coveredTo?: Date): Date {
  const configured = new Date(to.getTime() - Math.max(1, hours) * 3600_000);
  const floor = new Date(to.getTime() - MAX_BRIEF_LOOKBACK_DAYS * 24 * 3600_000);
  const start = coveredTo && coveredTo.getTime() < configured.getTime() ? coveredTo : configured;
  return start.getTime() < floor.getTime() ? floor : start;
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
