import { db, tx } from "./db";
import { parseDate, formatDate } from "./dates";
import { dayKey, weekStart } from "./week";

/**
 * The watching calendar: every date the sources mention, filed by how
 * precisely they mention it.
 *
 * Extraction records events with a sortable date where the text and the
 * publication date fix one, and the source's own words where they do not.
 * This module turns those rows into a calendar a reporter can watch. A day
 * the source named is a day. Everything vaguer is piled into a "Sometime in"
 * section — the week, the month or the year the wording allows, and never
 * more than that. "Last week" in a piece published on the 9th is the week of
 * the 4th, and a calendar that pretended to know the day would be lying in
 * the one place a reporter checks before phoning anyone.
 *
 * Nothing here consults a model. Bucketing is a pure function of the event's
 * fields and its source's publication date, which is what makes it testable
 * against fixed inputs and the same on both laptops.
 */

export type BucketKind = "day" | "week" | "month" | "year";

export interface Bucket {
  kind: BucketKind;
  /** Sortable: YYYY-MM-DD for a day or a week's first day, YYYY-MM, YYYY. */
  key: string;
  /** What the page prints. */
  label: string;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTH_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?/i;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const pad = (n: number) => String(n).padStart(2, "0");
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const monthLabel = (y: number, m: number) =>
  `Sometime in ${new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long" })} ${y}`;

export function dayBucket(d: Date): Bucket {
  return { kind: "day", key: dayKey(d), label: formatDate(d) };
}
export function weekBucket(d: Date): Bucket {
  const start = weekStart(d);
  return { kind: "week", key: dayKey(start), label: `Sometime in the week of ${formatDate(start)}` };
}
export function monthBucket(d: Date): Bucket {
  return { kind: "month", key: monthKey(d), label: monthLabel(d.getFullYear(), d.getMonth() + 1) };
}
export function yearBucket(y: number, decade = false): Bucket {
  return { kind: "year", key: String(y), label: decade ? `Sometime in the ${y}s` : `Sometime in ${y}` };
}

function shift(d: Date, opts: { days?: number; months?: number; years?: number }): Date {
  const out = new Date(d.getTime());
  if (opts.years) out.setFullYear(out.getFullYear() + opts.years);
  if (opts.months) out.setMonth(out.getMonth() + opts.months);
  if (opts.days) out.setDate(out.getDate() + opts.days);
  return out;
}

function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  return MONTHS.findIndex((m) => m.startsWith(w.slice(0, 3)));
}

/**
 * Where an event belongs on the calendar, or null when nothing in it fixes
 * even a year.
 *
 * The sortable date wins when the extractor produced one; its precision says
 * how wide the bucket is. Otherwise the source's own wording is read against
 * the publication date, and only for phrases whose meaning is settled —
 * "last week", "next month", "earlier this year", a month and a year, a bare
 * year. A weekday on its own is taken as the most recent one before
 * publication, which is how news copy uses it. Anything else is left out
 * rather than guessed.
 */
export function bucketFor(
  ev: { date_iso: string | null; precision: string | null; date_text: string | null },
  publishedAt: string | null
): Bucket | null {
  const iso = (ev.date_iso ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const d = parseDate(iso);
    if (d) {
      if (ev.precision === "month") return monthBucket(d);
      if (ev.precision === "year" || ev.precision === "decade") return yearBucket(d.getFullYear(), ev.precision === "decade");
      return dayBucket(d);
    }
  }
  if (/^\d{4}-\d{2}$/.test(iso)) {
    const [y, m] = iso.split("-").map(Number);
    if (m >= 1 && m <= 12) {
      if (ev.precision === "year" || ev.precision === "decade") return yearBucket(y, ev.precision === "decade");
      return { kind: "month", key: iso, label: monthLabel(y, m) };
    }
  }
  if (/^\d{4}$/.test(iso)) return yearBucket(Number(iso), ev.precision === "decade");

  const text = (ev.date_text ?? "").trim().toLowerCase();
  if (!text) return null;
  const pub = parseDate(publishedAt);

  // Absolute wording first, since it needs no anchor. A day-and-month form
  // is tried before month-and-year, or "20 October 2027" would be read as
  // the month; the word boundary after the day keeps "October 2027" from
  // being read as the 20th.
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE.source}(?:,?\\s+(\\d{4}))?`, "i").exec(text);
  if (dayMonth) {
    const m = monthIndex(dayMonth[2]);
    const day = Number(dayMonth[1]);
    const year = dayMonth[3] ? Number(dayMonth[3]) : pub?.getFullYear();
    if (m >= 0 && day >= 1 && day <= 31 && year) return dayBucket(new Date(year, m, day));
  }
  const monthDay = new RegExp(`${MONTH_RE.source}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "i").exec(text);
  if (monthDay) {
    const m = monthIndex(monthDay[1]);
    const day = Number(monthDay[2]);
    const year = monthDay[3] ? Number(monthDay[3]) : pub?.getFullYear();
    if (m >= 0 && day >= 1 && day <= 31 && year) return dayBucket(new Date(year, m, day));
  }
  const monthYear = new RegExp(`${MONTH_RE.source}\\s+(\\d{4})`, "i").exec(text);
  if (monthYear) {
    const m = monthIndex(monthYear[1]);
    if (m >= 0) {
      const y = Number(monthYear[2]);
      return { kind: "month", key: `${y}-${pad(m + 1)}`, label: monthLabel(y, m + 1) };
    }
  }
  const season = /\b(spring|summer|autumn|fall|winter)\b(?:\s+of)?\s+(\d{4})/.exec(text);
  if (season) return yearBucket(Number(season[2]));
  const decade = /\b(1[89]\d0|20\d0)s\b/.exec(text);
  if (decade) return yearBucket(Number(decade[1]), true);
  const bareYear = /\b(1[89]\d{2}|20\d{2})\b/.exec(text);
  if (bareYear) return yearBucket(Number(bareYear[1]));

  // Relative wording needs the publication date to mean anything.
  if (!pub) return null;
  if (/\byesterday\b/.test(text)) return dayBucket(shift(pub, { days: -1 }));
  if (/\btomorrow\b/.test(text)) return dayBucket(shift(pub, { days: 1 }));
  if (/\btoday\b|\bthis (morning|afternoon|evening)\b|\btonight\b/.test(text)) return dayBucket(pub);

  if (/\b(last|past|previous)\s+(week|weekend|few days|several days)\b/.test(text)) {
    return weekBucket(shift(pub, { days: -7 }));
  }
  if (/\b(next|coming)\s+(week|weekend)\b|\bin the coming days\b|\bin the (next|coming) few days\b/.test(text)) {
    return weekBucket(shift(pub, { days: 7 }));
  }
  if (/\bthis (week|weekend)\b|\b(earlier|later) this week\b|\bin recent days\b|\bpast few days\b/.test(text)) {
    return weekBucket(pub);
  }

  if (/\b(last|past|previous)\s+month\b/.test(text)) return monthBucket(shift(pub, { months: -1 }));
  if (/\bnext month\b/.test(text)) return monthBucket(shift(pub, { months: 1 }));
  if (
    /\bthis month\b|\b(earlier|later) this month\b|\bin recent weeks\b|\bin the (coming|next few|past few|last few) weeks\b|\brecently\b/.test(
      text
    )
  ) {
    return monthBucket(pub);
  }

  if (/\b(last|past|previous)\s+year\b/.test(text)) return yearBucket(pub.getFullYear() - 1);
  if (/\bnext year\b|\bearly next year\b/.test(text)) return yearBucket(pub.getFullYear() + 1);
  if (
    /\bthis year\b|\b(earlier|later) this year\b|\bend of (the )?year\b|\bin recent months\b|\bin the (coming|next few|past few|last few) months\b/.test(
      text
    )
  ) {
    return yearBucket(pub.getFullYear());
  }

  const weekday = new RegExp(`\\b(next\\s+)?(${WEEKDAYS.join("|")})\\b`).exec(text);
  if (weekday) {
    const want = WEEKDAYS.indexOf(weekday[2]);
    const d = new Date(pub.getFullYear(), pub.getMonth(), pub.getDate());
    if (weekday[1]) {
      // "next Tuesday": the first one strictly after publication.
      const ahead = (want - d.getDay() + 7) % 7 || 7;
      return dayBucket(shift(d, { days: ahead }));
    }
    // "on Tuesday": the most recent one, publication day included.
    const back = (d.getDay() - want + 7) % 7;
    return dayBucket(shift(d, { days: -back }));
  }

  return null;
}

/** Whether a bucket has passed, is now, or is still to come — as of `now`. */
export function tenseOf(
  b: Pick<Bucket, "kind" | "key">,
  now = new Date()
): "past" | "current" | "upcoming" {
  const today = dayKey(now);
  switch (b.kind) {
    case "day":
      return b.key < today ? "past" : b.key > today ? "upcoming" : "current";
    case "week": {
      const end = dayKey(shift(parseDate(b.key) ?? now, { days: 7 }));
      return end <= today ? "past" : b.key > today ? "upcoming" : "current";
    }
    case "month": {
      const m = monthKey(now);
      return b.key < m ? "past" : b.key > m ? "upcoming" : "current";
    }
    default: {
      const y = String(now.getFullYear());
      return b.key < y ? "past" : b.key > y ? "upcoming" : "current";
    }
  }
}

/** The same window rule the brief uses, so the calendar and the brief agree
 *  on what "arrived" means. Kept here rather than imported to avoid a cycle. */
const IN_WINDOW = `COALESCE(s.kept_at, s.published_at, s.added_at) >= @from
                   AND COALESCE(s.kept_at, s.published_at, s.added_at) < @to
                   AND (s.triage IS NULL OR s.triage = 'kept')`;

/**
 * Notices every dated event in the sources of a window and files it.
 *
 * Called when a brief is prepared, with the brief's own window, so the
 * calendar grows as the briefs do. Idempotent: an event already filed is
 * skipped, so writing the same brief twice does not file its dates twice.
 * Returns how many were new.
 */
export function logCalendar(from: Date, to: Date, loggedFrom: string): number {
  const rows = db()
    .prepare(
      `SELECT e.id AS event_id, e.entity_id, e.source_id, e.mention_id,
              e.date_text, e.date_iso, e.precision, e.summary,
              s.published_at, s.added_at
         FROM events e
         JOIN sources s ON s.id = e.source_id
        WHERE ${IN_WINDOW}
          AND e.summary IS NOT NULL AND e.summary <> ''
          AND NOT EXISTS (SELECT 1 FROM calendar c WHERE c.event_id = e.id)
        ORDER BY e.id`
    )
    .all({ from: from.toISOString(), to: to.toISOString() }) as {
    event_id: number;
    entity_id: number;
    source_id: number | null;
    mention_id: number | null;
    date_text: string | null;
    date_iso: string | null;
    precision: string | null;
    summary: string;
    published_at: string | null;
    added_at: string;
  }[];

  const insert = db().prepare(
    `INSERT OR IGNORE INTO calendar
       (event_id, entity_id, source_id, mention_id, kind, bucket, label, date_text, date_iso, precision, summary, logged_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  return tx(() => {
    let added = 0;
    for (const r of rows) {
      const b = bucketFor(r, r.published_at ?? r.added_at);
      if (!b) continue;
      const info = insert.run(
        r.event_id,
        r.entity_id,
        r.source_id,
        r.mention_id,
        b.kind,
        b.key,
        b.label,
        r.date_text,
        r.date_iso,
        r.precision,
        r.summary.trim().slice(0, 500),
        loggedFrom
      );
      added += info.changes;
    }
    return added;
  });
}

export interface CalendarRow {
  id: number;
  event_id: number;
  entity_id: number;
  entity: string;
  entity_type: string;
  source_id: number | null;
  source_title: string | null;
  outlet: string | null;
  url: string | null;
  mention_id: number | null;
  chunk_id: number | null;
  kind: BucketKind;
  bucket: string;
  label: string;
  date_text: string | null;
  date_iso: string | null;
  summary: string;
  logged_from: string | null;
  logged_at: string;
  dismissed: number;
  tense: "past" | "current" | "upcoming";
}

const ROW_COLUMNS = `
  c.id, c.event_id, c.entity_id, c.source_id, c.mention_id, c.kind, c.bucket, c.label,
  c.date_text, c.date_iso, c.summary, c.logged_from, c.logged_at, c.dismissed,
  COALESCE(k.canonical_name, e.canonical_name) AS entity,
  COALESCE(k.type, e.type) AS entity_type,
  s.title AS source_title, s.outlet, s.url,
  m.chunk_id`;

const ROW_JOINS = `
  FROM calendar c
  JOIN entities e ON e.id = c.entity_id
  LEFT JOIN entities k ON k.id = e.merged_into
  LEFT JOIN sources s ON s.id = c.source_id
  LEFT JOIN mentions m ON m.id = c.mention_id`;

function withTense(rows: Omit<CalendarRow, "tense">[], now: Date): CalendarRow[] {
  return rows.map((r) => ({ ...r, tense: tenseOf({ kind: r.kind, key: r.bucket }, now) }));
}

/** Everything a brief filed, for the block under that brief. */
export function calendarFor(loggedFrom: string, now = new Date()): CalendarRow[] {
  const rows = db()
    .prepare(
      `SELECT ${ROW_COLUMNS} ${ROW_JOINS} WHERE c.logged_from = ? AND c.dismissed = 0 ORDER BY c.bucket, c.id`
    )
    .all(loggedFrom) as Omit<CalendarRow, "tense">[];
  return withTense(rows, now);
}

export interface CalendarGroup {
  label: string;
  kind: BucketKind;
  bucket: string;
  tense: CalendarRow["tense"];
  items: CalendarRow[];
}

export interface CalendarSections {
  /** Days still to come, soonest first. Today counts. */
  upcoming: CalendarRow[];
  /** Weeks, months and years, grouped under their label. Future first. */
  sometime: CalendarGroup[];
  /** Days that have passed, most recent first. */
  past: CalendarRow[];
  counts: { total: number; dismissed: number };
}

/**
 * The whole calendar, in the three shapes the page draws.
 *
 * Exact days split into what is coming and what has been; today counts as
 * coming, because it is the one you most need to see. The vaguer buckets are
 * grouped under their label — every "Sometime in September 2026" together —
 * with the future groups first, nearest first, and the past ones after,
 * most recent first.
 */
export function listCalendar(opts: { pastDays?: number; now?: Date } = {}): CalendarSections {
  const now = opts.now ?? new Date();
  const pastFloor = dayKey(shift(now, { days: -(opts.pastDays ?? 120) }));
  const rows = withTense(
    db()
      .prepare(`SELECT ${ROW_COLUMNS} ${ROW_JOINS} WHERE c.dismissed = 0 ORDER BY c.bucket, c.id`)
      .all() as Omit<CalendarRow, "tense">[],
    now
  );

  const upcoming = rows
    .filter((r) => r.kind === "day" && r.tense !== "past")
    .sort((a, b) => a.bucket.localeCompare(b.bucket) || a.id - b.id);
  const past = rows
    .filter((r) => r.kind === "day" && r.tense === "past" && r.bucket >= pastFloor)
    .sort((a, b) => b.bucket.localeCompare(a.bucket) || a.id - b.id);

  const groups = new Map<string, CalendarGroup>();
  for (const r of rows) {
    if (r.kind === "day") continue;
    const key = `${r.kind}:${r.bucket}`;
    const g = groups.get(key) ?? { label: r.label, kind: r.kind, bucket: r.bucket, tense: r.tense, items: [] };
    g.items.push(r);
    groups.set(key, g);
  }
  // A year bucket sorts as its first day so it sits among the months.
  const first = (g: { kind: BucketKind; bucket: string }) =>
    g.kind === "year" ? `${g.bucket}-01-01` : g.kind === "month" ? `${g.bucket}-01` : g.bucket;
  const sometime = [...groups.values()].sort((a, b) => {
    const ap = a.tense === "past" ? 1 : 0;
    const bp = b.tense === "past" ? 1 : 0;
    if (ap !== bp) return ap - bp;
    return ap ? first(b).localeCompare(first(a)) : first(a).localeCompare(first(b));
  });

  const counts = db()
    .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(dismissed), 0) AS dismissed FROM calendar")
    .get() as { total: number; dismissed: number };
  return { upcoming, sometime, past, counts };
}

export function dismissCalendar(id: number, dismissed = true): boolean {
  return db().prepare("UPDATE calendar SET dismissed=? WHERE id=?").run(dismissed ? 1 : 0, id).changes > 0;
}
