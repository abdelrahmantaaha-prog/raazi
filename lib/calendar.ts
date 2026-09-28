import { db, tx } from "./db";
import { parseDate, formatDate } from "./dates";
import { dayKey, weekStart } from "./week";
import { titleSimilarity, titleWords } from "./stories";

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

/**
 * `annual` is a day the source named without a year, for something that has
 * already happened: "the October 7 attack" in a piece published in September.
 * The calendar cannot know the year the source left out, and guessing the
 * publication year filed the attack as an event five weeks *ahead* — the one
 * mistake a watching calendar must never make. What it can know is the day,
 * and to a reporter that day is an anniversary, which is exactly a calendar's
 * business. So it recurs: keyed MM-DD, shown on its next occurrence.
 */
export type BucketKind = "day" | "week" | "month" | "year" | "annual";

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
export function annualBucket(month: number, day: number): Bucket {
  const name = new Date(2000, month - 1, 1).toLocaleDateString("en-GB", { month: "long" });
  return { kind: "annual", key: `${pad(month)}-${pad(day)}`, label: `Every ${day} ${name}` };
}

/** The next YYYY-MM-DD on which an annual bucket falls, today included. */
export function nextOccurrence(key: string, now = new Date()): string {
  const [m, d] = key.split("-").map(Number);
  const thisYear = new Date(now.getFullYear(), m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return dayKey(thisYear >= today ? thisYear : new Date(now.getFullYear() + 1, m - 1, d));
}

/** Whether the source's wording carries a four-digit year at all. */
const hasYear = (text: string | null | undefined) => /\b(1[89]\d{2}|20\d{2})\b/.test(text ?? "");

/**
 * The words that say a happening is still to come. Checked before anything
 * else, because news copy about the future is almost always explicit about it
 * — "scheduled", "will", "is due to", "prepares to travel on" — and a day
 * named that way, without a year, is this year's.
 */
const FUTURE_RE =
  /\b(will|would|shall|is (?:due|set|expected|scheduled|slated|poised|likely) to|are (?:due|set|expected|scheduled|slated|poised|likely) to|due to|set to|scheduled|slated|expected|upcoming|to be held|takes? place|plans? to|planning to|prepares? to|preparing to|to vote|vote on|deadline|expires?|until|reconvenes?|returns? to|opens?|begins?|starts?|kicks? off|ahead of|next)\b/i;

/** The words that say it already happened. */
const PAST_RE =
  /\b(was|were|had|has|have|did|killed|died|launched|attacked|struck|happened|occurred|took place|began|ended|won|lost|signed|announced|said|told|resulted|invaded|seized|declared|founded|born|toppled|overthrew|assassinat\w*|bomb\w*|massacre\w*)\b|\b[a-z]{3,}ed\b/i;

/** Wording that names the day *as* an anniversary, whichever way it falls. */
const ANNIVERSARY_RE =
  /\b(anniversary|anniversaries|years? (?:since|after|ago|on from|to the day)|commemorat\w*|remembrance|marks? (?:the )?\d+ years|decades? (?:since|after|ago))\b/i;

/**
 * Whether a summary describes something that has already happened. Future
 * wording wins outright — "is scheduled to vote" contains "vote", and a
 * reader would not call that past.
 */
export function readsAsPast(summary: string | null | undefined): boolean {
  const s = (summary ?? "").trim();
  if (!s) return false;
  if (FUTURE_RE.test(s)) return false;
  return PAST_RE.test(s);
}

/**
 * Wording that can only mean the thing is still to come. Narrower than
 * FUTURE_RE, which also holds words like "until" and "opens" that sit as
 * easily in a report of something done ("called for a ban until the war
 * ends").
 */
const PLAINLY_AHEAD_RE =
  // Not "plan to": "put out a plan to begin rebuilding Gaza" is a thing done.
  /\b(will|shall|(?:is|are) (?:due|set|expected|scheduled|slated|poised) to|scheduled to|slated to|set to|planning to|intends? to|preparing to|to be held)\b/i;

/**
 * The day a piece was written, where it was written.
 *
 * Relative wording — "today", "on Wednesday evening" — is the writer's, and
 * the desk's outlets are North American. A Washington piece filed on a
 * Wednesday evening is stamped after midnight on this machine, so "today's
 * vote" was filed a day late and "is scheduled to meet on Wednesday
 * evening" a week late. The publication moment is read as a day in
 * Washington and returned as that date at local midnight, which is what
 * the day arithmetic below expects.
 */
const WRITER_TIME_ZONE = "America/New_York";

function writerDay(pub: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: WRITER_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(pub)
    .split("-")
    .map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

/** Reported speech: "states that the strait will open" happened when it was said. */
const SAID_RE =
  /\b(says?|said|states?|stated|tells?|told|warns?|warned|announces?|announced|claims?|claimed|argues?|argued|predicts?|predicted|writes?|wrote|insists?|insisted|vows?|vowed|promises?|promised|pledges?|pledged)\b/i;

function plainlyAhead(summary: string | null | undefined): boolean {
  const s = (summary ?? "").trim();
  const ahead = PLAINLY_AHEAD_RE.exec(s);
  if (!ahead) return false;
  const said = SAID_RE.exec(s);
  if (said && said.index < ahead.index) return false;
  // "scheduled to" carries its own -ed; anything else past-tense says done.
  return !PAST_RE.test(s.replace(PLAINLY_AHEAD_RE, " "));
}

/** How far past publication a yearless day may fall before "it already
 *  happened" stops being plausible for this year: a few days covers copy
 *  written over a weekend and published on the Monday. */
const GRACE_DAYS = 3;

/**
 * A day the source named without a year: this year's, or an anniversary?
 *
 * The year the source left out was being filled in with the publication
 * year, always. That is right for "the vote on Oct. 19" and wrong for "the
 * Oct. 7 attack", and the two are told apart by the one thing this function
 * looks at: whether the summary describes something still to come or
 * something already done. A done thing that falls *after* publication cannot
 * be this year's, so it is filed as the anniversary it is. Wording that
 * itself says "anniversary" or "years since" is an anniversary wherever it
 * falls. Everything else — a scheduled vote ahead, a strike earlier this
 * month — keeps the publication year, as before.
 */
function yearlessDay(d: Date, pub: Date | null, summary: string | null | undefined, text: string): Bucket {
  // Only a bare month-and-day can be an anniversary. A day the wording
  // fixed against publication — "Friday", "this past weekend" — is that
  // day, whatever the ceremony on it was commemorating: the speech at the
  // memorial happened on the 11th of this year, once.
  const words = `${summary ?? ""} ${text}`;
  if (ANNIVERSARY_RE.test(words) && !RELATIVE_RE.test(text)) return annualBucket(d.getMonth() + 1, d.getDate());
  if (pub) {
    const horizon = shift(pub, { days: GRACE_DAYS });
    if (d > horizon && readsAsPast(summary)) return annualBucket(d.getMonth() + 1, d.getDate());
  }
  return dayBucket(d);
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
/**
 * Wording that places a happening against the day of publication rather
 * than on a named day: "last week", "over the weekend", "three days later",
 * "on Tuesday". Such wording is read by the rules below and not from the
 * extractor's sortable date, however precise that date looks.
 *
 * The extractor is asked to resolve relative wording and does, but it
 * rounds to a day whatever the words allowed: "last week" arrived as
 * 2026-09-07, "as soon as this week" as the 15th, "just a few days after"
 * as the 9th with precision "unknown", and the calendar printed all three
 * as days a reporter could ring someone about. The words are the only
 * honest measure of the precision, and they are deterministic to read.
 */
const RELATIVE_RE = new RegExp(
  [
    "yesterday", "today", "tonight", "tomorrow",
    "this (?:morning|afternoon|evening)",
    "(?:this|the|last|past|next|coming|this past|over the|at the) (?:past )?weekend",
    "(?:this|last|past|previous|next|coming) (?:week|month|year|spring|summer|autumn|fall|winter)",
    "(?:earlier|later) (?:this|in the) (?:week|month|year)",
    "as soon as this week", "in the coming days", "in recent (?:days|weeks|months)",
    "in the (?:coming|next|past|last)(?: few)? (?:days|weeks|months)",
    "(?:past|last) few (?:days|weeks|months)", "recently",
    "(?:the )?(?:next|following|previous) day", "the day (?:before|after)",
    "(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|some|just a few|a few|few|\\d+) (?:days?|weeks?|months?|years?|decades?) (?:later|after|earlier|before|ago|on)",
    "days (?:later|after|earlier|before|ago)",
    "in (?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|\\d+) (?:days?|weeks?|months?)",
    "end of (?:the )?(?:week|month|year)",
    WEEKDAYS.join("|"),
  ].join("|"),
  "i"
);

/** Whether the wording names a month or a year outright, which anchors it without publication. */
const hasMonth = (text: string) => MONTH_RE.test(text);

const SMALL_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
function smallNumber(word: string): number {
  return SMALL_NUMBERS[word] ?? (Number(word) || 1);
}

/** The most recent Saturday on or before a day: where "the weekend" sits in weekday copy. */
function lastSaturday(d: Date): Date {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return shift(day, { days: -((day.getDay() + 1) % 7) });
}

const SEASON_END: Record<string, number> = { spring: 5, summer: 8, autumn: 11, fall: 11 };

/**
 * "This summer" in a September piece is not "sometime in 2026": it is June
 * to August, and it is over. A season is filed as a month bucket keyed to
 * its last month, so it sorts and tenses with the months, under its own
 * label. Winter straddles the year and is left to the year rule.
 */
function seasonBucket(season: string, year: number): Bucket {
  const name = season === "fall" ? "autumn" : season;
  return { kind: "month", key: `${year}-${pad(SEASON_END[season])}`, label: `Sometime in ${name} ${year}` };
}

/**
 * Relative wording read against the day of publication. Returns null for
 * wording the rules do not settle, which the caller then reads as vaguely
 * as it can rather than as a day.
 *
 * `iso` is the extractor's own resolution of the same words, used only
 * where the words point at another event rather than at publication —
 * "three days later" — since the extractor alone saw what "later" than.
 * Even then it is filed as a week: the words did not fix the day.
 */
function relativeBucket(text: string, published: Date, iso: string, summary?: string | null): Bucket | null {
  const pub = writerDay(published);
  if (/\byesterday\b/.test(text)) return dayBucket(shift(pub, { days: -1 }));
  if (/\btomorrow\b/.test(text)) return dayBucket(shift(pub, { days: 1 }));
  if (/\btoday\b|\bthis (morning|afternoon|evening)\b|\btonight\b/.test(text)) return dayBucket(pub);

  if (/\b(next|coming)\s+weekend\b/.test(text)) return weekBucket(shift(lastSaturday(pub), { days: 7 }));
  if (/\bweekend\b/.test(text)) return weekBucket(lastSaturday(pub));

  const count = /\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|some|few|\d+)\s+(day|week|month|year|decade)s?\s+(later|after|earlier|before|ago|on)\b/.exec(
    text
  );
  if (count) {
    const n = smallNumber(count[1]);
    const unit = count[2];
    const ago = /^(ago|earlier|before)$/.test(count[3]);
    if (ago) {
      if (unit === "day") return n <= 3 ? dayBucket(shift(pub, { days: -n })) : weekBucket(shift(pub, { days: -n }));
      if (unit === "week") return weekBucket(shift(pub, { days: -7 * n }));
      if (unit === "month") return monthBucket(shift(pub, { months: -n }));
      if (unit === "year") return yearBucket(pub.getFullYear() - n);
      return yearBucket(pub.getFullYear() - 10 * n, true);
    }
    // "later", "after", "on": counted from something other than publication.
    const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? parseDate(iso) : null;
    if (unit === "day" || unit === "week") return d ? weekBucket(d) : monthBucket(pub);
    if (unit === "month") return d ? monthBucket(d) : yearBucket(pub.getFullYear());
    return /^\d{4}/.test(iso) ? yearBucket(Number(iso.slice(0, 4))) : null;
  }
  if (/\bdays (later|after|earlier|before|ago)\b|\b(the )?(next|following|previous) day\b|\bthe day (before|after)\b/.test(text)) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? parseDate(iso) : null;
    return d ? weekBucket(d) : monthBucket(pub);
  }
  const ahead = /\bin\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(day|week|month)s?\b/.exec(text);
  if (ahead) {
    const n = smallNumber(ahead[1]);
    if (ahead[2] === "day") return weekBucket(shift(pub, { days: n }));
    if (ahead[2] === "week") return weekBucket(shift(pub, { days: 7 * n }));
    return monthBucket(shift(pub, { months: n }));
  }

  if (/\b(last|past|previous)\s+(week|few days|several days)\b/.test(text)) {
    return weekBucket(shift(pub, { days: -7 }));
  }
  if (/\b(next|coming)\s+week\b|\bin the coming days\b|\bin the (next|coming) few days\b|\bend of (the )?week\b/.test(text)) {
    return weekBucket(shift(pub, { days: 7 }));
  }
  if (/\bthis week\b|\b(earlier|later) this week\b|\bin recent days\b|\bpast few days\b/.test(text)) {
    return weekBucket(pub);
  }

  if (/\b(last|past|previous)\s+month\b/.test(text)) return monthBucket(shift(pub, { months: -1 }));
  if (/\bnext month\b/.test(text)) return monthBucket(shift(pub, { months: 1 }));
  if (
    /\bthis month\b|\b(earlier|later) (this|in the) month\b|\bin recent weeks\b|\bin the (coming|next few|past few|last few) weeks\b|\brecently\b|\bend of (the )?month\b/.test(
      text
    )
  ) {
    return monthBucket(pub);
  }

  const season = /\b(this|last|past|next|coming)\s+(spring|summer|autumn|fall)\b/.exec(text);
  if (season) {
    const offset = /^(last|past)$/.test(season[1]) ? -1 : /^(next|coming)$/.test(season[1]) ? 1 : 0;
    return seasonBucket(season[2], pub.getFullYear() + offset);
  }

  if (/\b(last|past|previous)\s+year\b/.test(text)) return yearBucket(pub.getFullYear() - 1);
  if (/\bnext year\b|\bearly next year\b/.test(text)) return yearBucket(pub.getFullYear() + 1);
  if (
    /\bthis (year|winter)\b|\b(earlier|later) (this|in the) year\b|\bend of (the )?year\b|\bin recent months\b|\bin the (coming|next few|past few|last few) months\b|\b(last|next|coming)\s+winter\b/.test(
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
    // "planning to meet on Tuesday": the coming one, publication day
    // included. Only when the summary says so plainly — "scheduled",
    // "will", "planning to" — and nothing in it reads as done; the default
    // stays the past, which is how news copy uses a bare weekday. The 29
    // September brief filed the White House's Tuesday meeting with AI
    // executives under the Tuesday before, as already over.
    if (plainlyAhead(summary)) {
      return dayBucket(shift(d, { days: (want - d.getDay() + 7) % 7 }));
    }
    // "on Tuesday": the most recent one, publication day included.
    const back = (d.getDay() - want + 7) % 7;
    return dayBucket(shift(d, { days: -back }));
  }

  return null;
}

export function bucketFor(
  ev: { date_iso: string | null; precision: string | null; date_text: string | null; summary?: string | null },
  publishedAt: string | null
): Bucket | null {
  const iso = (ev.date_iso ?? "").trim();
  const pub = parseDate(publishedAt);
  const textRaw = (ev.date_text ?? "").trim();
  const text = textRaw.toLowerCase();

  // A yearless recurring form — "--10-07" is ISO 8601 for the day itself.
  const recurring = /^(?:--)?(\d{2})-(\d{2})$/.exec(iso);
  if (recurring) {
    const [, m, d] = recurring.map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return annualBucket(m, d);
  }

  // Wording anchored on publication is read from the wording. A month or a
  // year in the text anchors it on its own ("Sunday, Sept. 13"), so those
  // keep the absolute reading below.
  const relative = Boolean(pub) && !hasMonth(text) && !hasYear(text) && RELATIVE_RE.test(text);
  if (relative && pub) {
    const b = relativeBucket(text, pub, iso, ev.summary);
    if (b) return b;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const d = parseDate(iso);
    if (d) {
      if (ev.precision === "month") return monthBucket(d);
      if (ev.precision === "year" || ev.precision === "decade") return yearBucket(d.getFullYear(), ev.precision === "decade");
      // A day the extractor could not vouch for, or one it reached from
      // wording that fixed no day, is a week at most.
      if (ev.precision === "unknown" || relative) return weekBucket(d);
      // The extractor may itself have supplied the publication year to a day
      // the source gave without one. Same question, same answer.
      if (pub && !hasYear(textRaw) && textRaw && d.getFullYear() === pub.getFullYear()) {
        return yearlessDay(d, pub, ev.summary, textRaw);
      }
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

  if (!text) return null;

  // Absolute wording first, since it needs no anchor. A day-and-month form
  // is tried before month-and-year, or "20 October 2027" would be read as
  // the month; the word boundary after the day keeps "October 2027" from
  // being read as the 20th.
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE.source}(?:,?\\s+(\\d{4}))?`, "i").exec(text);
  if (dayMonth) {
    const m = monthIndex(dayMonth[2]);
    const day = Number(dayMonth[1]);
    const year = dayMonth[3] ? Number(dayMonth[3]) : pub?.getFullYear();
    if (m >= 0 && day >= 1 && day <= 31 && year) {
      const d = new Date(year, m, day);
      return dayMonth[3] ? dayBucket(d) : yearlessDay(d, pub, ev.summary, text);
    }
  }
  const monthDay = new RegExp(`${MONTH_RE.source}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "i").exec(text);
  if (monthDay) {
    const m = monthIndex(monthDay[1]);
    const day = Number(monthDay[2]);
    const year = monthDay[3] ? Number(monthDay[3]) : pub?.getFullYear();
    if (m >= 0 && day >= 1 && day <= 31 && year) {
      const d = new Date(year, m, day);
      return monthDay[3] ? dayBucket(d) : yearlessDay(d, pub, ev.summary, text);
    }
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
  if (season) return season[1] === "winter" ? yearBucket(Number(season[2])) : seasonBucket(season[1], Number(season[2]));
  const decade = /\b(1[89]\d0|20\d0)s\b/.exec(text);
  if (decade) return yearBucket(Number(decade[1]), true);
  const bareYear = /\b(1[89]\d{2}|20\d{2})\b/.exec(text);
  if (bareYear) return yearBucket(Number(bareYear[1]));

  // A bare month with the publication's own year: "in September" in a
  // September piece. Vaguer than a day and honest about it.
  const bareMonth = MONTH_RE.exec(text);
  if (bareMonth && pub) {
    const m = monthIndex(bareMonth[1]);
    if (m >= 0) return { kind: "month", key: `${pub.getFullYear()}-${pad(m + 1)}`, label: monthLabel(pub.getFullYear(), m + 1) };
  }

  // Relative wording needs the publication date to mean anything.
  if (!pub) return null;
  return relativeBucket(text, pub, iso, ev.summary);
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
    // An anniversary is never past: it is today, or it is coming round.
    case "annual":
      return nextOccurrence(b.key, now) === today ? "current" : "upcoming";
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
    // Earlier filings are re-read under the current rules first, so a day
    // that was stamped with the wrong year before the anniversary rule
    // existed moves to where it belongs the next time any brief is prepared.
    refileCalendar();

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

/**
 * Re-buckets every line on the calendar under the current rules and moves the
 * ones that land somewhere else. Returns how many moved.
 *
 * Exists because the rules have changed under the rows once already: before
 * the anniversary rule, "the Oct. 7 attack" in a September piece was filed as
 * a day five weeks ahead. Filing is otherwise idempotent and never revisits
 * an event, so without this a correction would have applied only to dates
 * noticed after it. Cheap — a few hundred rows, no model — so it runs at the
 * start of every filing and on the page's own refresh.
 */
export function refileCalendar(): number {
  const rows = db()
    .prepare(
      `SELECT c.id, c.kind, c.bucket, c.label,
              e.date_text, e.date_iso, e.precision, e.summary,
              s.published_at, s.added_at
         FROM calendar c
         JOIN events e ON e.id = c.event_id
    LEFT JOIN sources s ON s.id = e.source_id`
    )
    .all() as {
    id: number;
    kind: BucketKind;
    bucket: string;
    label: string;
    date_text: string | null;
    date_iso: string | null;
    precision: string | null;
    summary: string | null;
    published_at: string | null;
    added_at: string | null;
  }[];
  const update = db().prepare("UPDATE calendar SET kind=?, bucket=?, label=? WHERE id=?");
  let moved = 0;
  for (const r of rows) {
    const b = bucketFor(r, r.published_at ?? r.added_at);
    if (!b) continue;
    if (b.kind !== r.kind || b.key !== r.bucket || b.label !== r.label) {
      update.run(b.kind, b.key, b.label, r.id);
      moved++;
    }
  }
  return moved;
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
  /** The line as the page prints it: a sentence that says who, without the
   *  relative wording the date heading has replaced. */
  text: string;
  /** Every calendar row this line stands for, itself first — for dismissing. */
  ids: number[];
  /** The other rows it stands for: the same happening on the same date,
   *  recorded on another entity or from another outlet. */
  also: CalendarSource[];
}

export interface CalendarSource {
  id: number;
  entity_id: number;
  entity: string;
  source_id: number | null;
  source_title: string | null;
  outlet: string | null;
  chunk_id: number | null;
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

type StoredRow = Omit<CalendarRow, "tense" | "text" | "ids" | "also">;

function withTense(rows: StoredRow[], now: Date): CalendarRow[] {
  return consolidate(
    rows.map((r) => ({
      ...r,
      tense: tenseOf({ kind: r.kind, key: r.bucket }, now),
      text: calendarSentence(r),
      ids: [r.id],
      also: [],
    }))
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A first word that is a verb, so the line needs the entity as its subject. */
const OPENING_VERB =
  /^(says?|said|tells?|told|writes?|wrote|meets?|met|signs?|issues?|releases?|delivers?|shares?|calls?|announces?|urges?|warns?|argues?|backs?|plans?|votes?|holds?|leads?|joins?|asks?|visits?|speaks?|spoke|gives?|gave|takes?|took|makes?|made|sends?|sent|files?|sues?|won|wins?|loses?|lost|steps?|faces?|launche[sd]|[a-z]{3,}ed)$/i;

/**
 * The summary as a calendar line.
 *
 * The extractor writes each event from its entity's point of view, so a line
 * often has no subject — "Released a news release calling for an export ban",
 * "scheduled referendum on separation" — and printed under a date among
 * other people's lines it no longer says who. It also keeps the words that
 * dated it, "on Tuesday", "late Sunday night", "earlier this year", which
 * under a date heading read against today rather than the article. So: the
 * words that gave the date go (they are shown beside the line, quoted), a
 * line that opens on a verb gets its entity as the subject, and it reads as
 * a sentence. No model: the same line on both laptops.
 */
export function calendarSentence(r: { summary: string; entity: string; date_text: string | null }): string {
  let s = r.summary.replace(/\s+/g, " ").trim();
  const dated = (r.date_text ?? "").trim();
  if (dated && RELATIVE_RE.test(dated.toLowerCase()) && !hasMonth(dated.toLowerCase())) {
    // A single word — "Sunday" — goes only with its preposition, or "Fox
    // News Sunday" would lose its last word.
    const lead = "(?:on|in|during|by|at|from|until|since|last|this|next|late|early)\\s+";
    const cut = new RegExp(`,?\\s*\\b${/\s/.test(dated) ? `(?:${lead})?` : lead}${escapeRe(dated)}\\b,?`, "i");
    const trimmed = s.replace(cut, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
    // Only if a sentence is left: "Tuesday" was sometimes the whole summary.
    if (trimmed.split(" ").length >= 3) s = trimmed;
  }
  const first = s.split(" ")[0] ?? "";
  if (!names(s, r.entity) && OPENING_VERB.test(first)) s = `${r.entity} ${first.toLowerCase()}${s.slice(first.length)}`;
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?…"”’)]$/.test(s) ? s : `${s}.`;
}

/**
 * One line per happening, not per record of it.
 *
 * Extraction records a dated event on every entity it concerns, and every
 * outlet that reported it adds its own: election day on 3 November was three
 * lines (Republicans, the House, Speaker Johnson), the Alberta referendum
 * two, the end of the China trade truce two — one on the United States and
 * one on China, word for word. Lines under the same date whose words mostly
 * agree are folded into the fullest of them, and the rest are listed with it
 * as further sources.
 */
const SAME_HAPPENING = 0.5;
/**
 * Lines about different subjects must agree much more closely. "Signed an
 * executive order" on the same day was four governors and the president, and
 * "addressed the General Assembly" two heads of state — shared words, not a
 * shared happening. Unless one line names the other's subject ("Trump
 * welcomed Xi…" beside Xi's own line), different subjects need near-identical
 * wording, like the trade truce filed word for word on both countries.
 */
const SAME_HAPPENING_APART = 0.75;

function names(text: string, entity: string): boolean {
  const surname = entity.replace(/\(.*\)/, "").trim().split(/\s+/).pop() ?? "";
  return surname.length > 2 && new RegExp(`\\b${escapeRe(surname)}\\b`, "i").test(text);
}

function sameSubject(a: CalendarRow, b: CalendarRow): boolean {
  return a.entity_id === b.entity_id || names(a.text, b.entity) || names(b.text, a.entity);
}

export function consolidate(rows: CalendarRow[]): CalendarRow[] {
  const groups = new Map<string, CalendarRow[]>();
  for (const r of rows) {
    const key = `${r.kind}:${r.bucket}:${r.label}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: CalendarRow[] = [];
  for (const list of groups.values()) {
    const parent = list.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const words = list.map((r) => new Set(titleWords(r.text)));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        let shared = 0;
        for (const w of words[i]) if (words[j].has(w)) shared++;
        if (shared < 2) continue;
        const bar = sameSubject(list[i], list[j]) ? SAME_HAPPENING : SAME_HAPPENING_APART;
        if (titleSimilarity(list[i].text, list[j].text) >= bar) parent[find(j)] = find(i);
      }
    }
    const clusters = new Map<number, CalendarRow[]>();
    list.forEach((r, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), r]));
    for (const members of clusters.values()) {
      // The fullest line speaks for the rest.
      const [lead, ...rest] = [...members].sort((a, b) => b.text.length - a.text.length || a.id - b.id);
      out.push({
        ...lead,
        ids: members.map((m) => m.id).sort((a, b) => (a === lead.id ? -1 : b === lead.id ? 1 : a - b)),
        also: rest.map((m) => ({
          id: m.id,
          entity_id: m.entity_id,
          entity: m.entity,
          source_id: m.source_id,
          source_title: m.source_title,
          outlet: m.outlet,
          chunk_id: m.chunk_id,
        })),
      });
    }
  }
  return out.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.id - b.id);
}

/**
 * What a brief filed, for the block under that brief.
 *
 * Only the recent past and the future: a brief's sources also date the
 * background they retell — 1889, 2001, last March — and every one of
 * those was printed under the brief as though it were on watch. Anything
 * older than `pastDays` is the pedia's business. Anniversaries stay.
 */
export function calendarFor(loggedFrom: string, now = new Date(), opts: { pastDays?: number } = {}): CalendarRow[] {
  const floor = dayKey(shift(now, { days: -(opts.pastDays ?? 120) }));
  const rows = db()
    .prepare(
      `SELECT ${ROW_COLUMNS} ${ROW_JOINS} WHERE c.logged_from = ? AND c.dismissed = 0 ORDER BY c.bucket, c.id`
    )
    .all(loggedFrom) as StoredRow[];
  const recent = rows.filter((r) => {
    if (r.kind === "annual") return true;
    const first = r.kind === "year" ? `${r.bucket}-12-31` : r.kind === "month" ? `${r.bucket}-31` : r.bucket;
    return first >= floor;
  });
  return withTense(recent, now);
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
  /** Days named without a year for things already done — anniversaries.
   *  Each recurs; sorted by its next occurrence. */
  annual: CalendarRow[];
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
      .all() as StoredRow[],
    now
  );

  const upcoming = rows
    .filter((r) => r.kind === "day" && r.tense !== "past")
    .sort((a, b) => a.bucket.localeCompare(b.bucket) || a.id - b.id);
  const past = rows
    .filter((r) => r.kind === "day" && r.tense === "past" && r.bucket >= pastFloor)
    .sort((a, b) => b.bucket.localeCompare(a.bucket) || a.id - b.id);

  const annual = rows
    .filter((r) => r.kind === "annual")
    .sort((a, b) => nextOccurrence(a.bucket, now).localeCompare(nextOccurrence(b.bucket, now)) || a.id - b.id);

  const groups = new Map<string, CalendarGroup>();
  for (const r of rows) {
    if (r.kind === "day" || r.kind === "annual") continue;
    // The label is part of the key so a season, filed under its last
    // month, stays its own group beside that month's.
    const key = `${r.kind}:${r.bucket}:${r.label}`;
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
  return { upcoming, sometime, past, annual, counts };
}

export function dismissCalendar(id: number, dismissed = true): boolean {
  return db().prepare("UPDATE calendar SET dismissed=? WHERE id=?").run(dismissed ? 1 : 0, id).changes > 0;
}
