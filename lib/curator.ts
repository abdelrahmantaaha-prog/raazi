import { db } from "./db";

/**
 * What your decisions in the inbox teach the feeds.
 *
 * Nothing here calls a model, and nothing here is stored: the memory is the
 * decision log itself — kept, filed, discarded, and put back — read over a
 * fixed window, so it cannot grow and cannot drift. Three things are learned
 * from it, all deterministic and all reversible.
 *
 *   1. A feed's STANDING. A feed you have kept nothing from in dozens of
 *      decisions is noise on this beat, and its daily cap is lowered to a
 *      trickle until one of its items is kept. Nothing is unsubscribed; the
 *      Feeds page says what is happening and why.
 *
 *   2. PATTERNS worth setting aside. Where every one of the last twenty or
 *      forty items sharing a feature was discarded — the feed, the section
 *      of the site it came from, the shape of the headline (a bill number, a
 *      court case) — the next item with that feature is set aside before it
 *      is even fetched, marked as the curator's doing, and one click puts it
 *      back. Putting one back is a veto: the pattern stops firing.
 *
 *   3. The curator never learns from itself. Items it set aside are left out
 *      of the log it reads, so a pattern cannot confirm its own verdicts.
 *
 * A sweep — the morning you discard a hundred items in a minute to get the
 * inbox to zero — weighs a quarter as much per item as a decision made one
 * at a time. It is still a no, but a tired one.
 */

/** How far back the curator reads. */
export const LEARN_DAYS = 60;
/** Weighted discards a pattern needs before it counts at all. */
export const MIN_SUPPORT = 20;
/** Weighted discards that settle it on one pattern alone. */
export const SURE_SUPPORT = 40;
/** This many discards in one minute is a sweep, and each weighs a quarter. */
export const SWEEP_SIZE = 30;
export const SWEEP_WEIGHT = 0.25;
/** A feed on this standing takes at most this many items a day. */
export const NOISE_CAP = 3;
/** Keep rate at or below which a feed with enough decisions is noise. */
export const NOISE_RATE = 0.02;

/** The note an item set aside by the curator carries, followed by why. */
export const SET_ASIDE = "Set aside for you: ";

export type Standing = "earning" | "quiet" | "noise";

export interface Tally {
  /** Decisions made by hand, unweighted. */
  n: number;
  kept: number;
  /** Discards, with sweeps weighted down. */
  discarded: number;
  /** Items the curator set aside that you put back. */
  vetoes: number;
}

export interface Rule {
  feature: string;
  tally: Tally;
  /** Why, in the words the inbox shows. */
  reason: string;
}

export interface Verdict {
  setAside: boolean;
  rules: Rule[];
  reason: string;
}

/** What an item looks like before it is fetched. */
export interface Candidate {
  feedId: number;
  url: string | null;
  title: string;
}

/**
 * The features one item carries. Few, and each one a thing you would say
 * yourself: "everything from that feed", "everything under /sports/",
 * "every bill". Words of the headline are deliberately not features — a
 * subject you discard this month is the subject you follow next month, and
 * a vocabulary learned from a beat would keep saying no to it.
 */
export function featuresOf(item: Candidate): string[] {
  const out = [`feed:${item.feedId}`];
  const section = sectionOf(item.url);
  if (section) out.push(`section:${section}`);
  const shape = shapeOf(item.title);
  if (shape) out.push(`shape:${shape}`);
  return out;
}

/** "cbc.ca/sports" — the host and the first path segment that is a word. */
export function sectionOf(url: string | null): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  // The first two segments only: deeper than that is the article, not the
  // section. A year, a number, a date, an id are skipped over.
  for (const p of parts.slice(0, 2)) {
    const seg = p.toLowerCase();
    if (/^\d/.test(seg) || seg.length < 3 || seg.length > 40) continue;
    if (/\.(html?|php|aspx?)$/.test(seg)) continue;
    return `${host}/${seg}`;
  }
  return null;
}

/** The shape of a headline that is a document reference rather than a story. */
export function shapeOf(title: string): string | null {
  const t = title.replace(/&nbsp;| /g, " ").replace(/\s+/g, " ").trim();
  if (/^(H\.?\s?R\.?|S\.?|H\.?\s?J\.?\s?Res\.?|S\.?\s?J\.?\s?Res\.?|H\.?\s?Con\.?\s?Res\.?|S\.?\s?Con\.?\s?Res\.?)\s?\d+/i.test(t)) return "bill";
  if (/\bv\.\s+\S/.test(t) && /\(\d{2}-\d+\)|\bNo\.\s*\d|\bv\.\s+(United States|State|Commonwealth|People)\b/.test(t)) return "case";
  if (/^[A-Z]{2,5}-\d{2,}-\d+/.test(t)) return "report";
  return null;
}

/** Whether a feature belongs to a feed as a whole. */
const isFeed = (feature: string) => feature.startsWith("feed:");

export type Tallies = Map<string, Tally>;

/**
 * Reads the decision log once. Cheap — a few thousand rows — and called at
 * the start of a poll so every item in it is judged against the same memory.
 */
export function learn(days = LEARN_DAYS): Tallies {
  const since = `-${Math.max(1, Math.floor(days))} days`;
  const rows = db()
    .prepare(
      `SELECT feed_id, url, title, state, decided_at, vetoed_at,
              strftime('%Y-%m-%d %H:%M', decided_at) AS minute
         FROM feed_items
        WHERE (state IN ('kept', 'filed', 'discarded')
               AND decided_at >= datetime('now', ?)
               AND curated_at IS NULL)
           OR (vetoed_at IS NOT NULL AND vetoed_at >= datetime('now', ?))`
    )
    .all(since, since) as {
    feed_id: number;
    url: string | null;
    title: string | null;
    state: string;
    decided_at: string | null;
    vetoed_at: string | null;
    minute: string | null;
  }[];

  // A sweep is many discards inside one minute.
  const perMinute = new Map<string, number>();
  for (const r of rows) {
    if (r.state === "discarded" && r.minute && r.vetoed_at === null) {
      perMinute.set(r.minute, (perMinute.get(r.minute) ?? 0) + 1);
    }
  }

  const tallies: Tallies = new Map();
  const bump = (feature: string, fn: (t: Tally) => void) => {
    let t = tallies.get(feature);
    if (!t) tallies.set(feature, (t = { n: 0, kept: 0, discarded: 0, vetoes: 0 }));
    fn(t);
  };

  for (const r of rows) {
    const features = featuresOf({ feedId: r.feed_id, url: r.url, title: r.title ?? "" });
    if (r.vetoed_at) {
      for (const f of features) bump(f, (t) => t.vetoes++);
      // An item you put back and then decided on is also a decision — but
      // the curator's own set-aside, which is what was vetoed, is not.
      if (!r.decided_at || r.state === "discarded") continue;
    }
    if (r.state === "kept" || r.state === "filed") {
      for (const f of features) bump(f, (t) => { t.n++; t.kept++; });
    } else if (r.state === "discarded") {
      const sweep = (perMinute.get(r.minute ?? "") ?? 0) >= SWEEP_SIZE;
      const w = sweep ? SWEEP_WEIGHT : 1;
      for (const f of features) bump(f, (t) => { t.n++; t.discarded += w; });
    }
  }
  return tallies;
}

/** Whether every decision on this feature said no, often enough to act on. */
function fires(t: Tally | undefined, support = MIN_SUPPORT): t is Tally {
  return Boolean(t) && t!.kept === 0 && t!.vetoes === 0 && t!.discarded >= support;
}

function describe(feature: string, t: Tally, feedTitle: (id: number) => string): string {
  const n = Math.round(t.n);
  if (feature.startsWith("feed:")) return `you discarded all ${n} from ${feedTitle(Number(feature.slice(5)))}`;
  if (feature.startsWith("section:")) return `you discarded all ${n} under ${feature.slice(8)}`;
  if (feature === "shape:bill") return `you discarded all ${n} bills`;
  if (feature === "shape:case") return `you discarded all ${n} court cases`;
  if (feature === "shape:report") return `you discarded all ${n} numbered reports`;
  return `you discarded all ${n} like it`;
}

/**
 * Judges one item against the memory.
 *
 * Set aside when one pattern alone has forty discards and nothing else, or
 * when two independent patterns each have twenty. A section that is the
 * whole feed — a feed that publishes under one path — is not independent
 * of the feed, and does not count twice.
 */
export function judge(item: Candidate, tallies: Tallies, feedTitle: (id: number) => string = (id) => `feed ${id}`): Verdict {
  const features = featuresOf(item);
  const feedTally = tallies.get(`feed:${item.feedId}`);
  const rules: Rule[] = [];
  for (const f of features) {
    const t = tallies.get(f);
    if (!fires(t)) continue;
    rules.push({ feature: f, tally: t, reason: describe(f, t, feedTitle) });
  }

  const sure = rules.some((r) => r.tally.discarded >= SURE_SUPPORT);
  const independent = rules.filter((r) => {
    if (isFeed(r.feature) || !r.feature.startsWith("section:")) return true;
    // A section with exactly the feed's decisions is the feed under another name.
    return !feedTally || r.tally.n !== feedTally.n;
  });
  const setAside = sure || independent.length >= 2;
  return {
    setAside,
    rules,
    reason: rules.map((r) => r.reason).join("; "),
  };
}

export interface FeedStanding {
  standing: Standing;
  /** Decisions by hand in the window, and how many of them were kept. */
  decided: number;
  kept: number;
  /** The cap the poll actually applies. */
  effectiveCap: number;
}

/** Where a feed stands, and what its cap is today. */
export function standingOf(feedId: number, dailyCap: number, tallies: Tallies): FeedStanding {
  const t = tallies.get(`feed:${feedId}`);
  const decided = t ? t.n : 0;
  const kept = t ? t.kept : 0;
  if (!t || t.discarded + t.kept < MIN_SUPPORT) {
    return { standing: "quiet", decided, kept, effectiveCap: dailyCap };
  }
  const rate = t.kept / (t.kept + t.discarded);
  if (t.vetoes === 0 && rate <= NOISE_RATE) {
    return { standing: "noise", decided, kept, effectiveCap: Math.min(dailyCap, NOISE_CAP) };
  }
  return { standing: "earning", decided, kept, effectiveCap: dailyCap };
}

/** One line for the Feeds page, or null when there is nothing to say. */
export function explainStanding(s: FeedStanding): string | null {
  if (s.standing === "quiet") return null;
  if (s.standing === "noise") {
    return `kept 0 of ${s.decided} in ${LEARN_DAYS} days — taking ${s.effectiveCap} a day until one is kept`;
  }
  return `kept ${s.kept} of ${s.decided} in ${LEARN_DAYS} days`;
}

/** How many items the curator has set aside from a feed, and how many you put back. */
export function curatedCounts(): Map<number, { aside: number; back: number }> {
  const rows = db()
    .prepare(
      `SELECT feed_id,
              SUM(CASE WHEN curated_at IS NOT NULL AND vetoed_at IS NULL THEN 1 ELSE 0 END) AS aside,
              SUM(CASE WHEN vetoed_at IS NOT NULL THEN 1 ELSE 0 END) AS back
         FROM feed_items
        WHERE curated_at IS NOT NULL
        GROUP BY feed_id`
    )
    .all() as { feed_id: number; aside: number; back: number }[];
  return new Map(rows.map((r) => [r.feed_id, { aside: r.aside, back: r.back }]));
}
