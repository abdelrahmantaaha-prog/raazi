import { Type, type Schema } from "@google/genai";
import { db, tx } from "./db";
import { generateJson } from "./ai/client";
import {
  COMMON_NAMES,
  MAX_STORY_ACCOUNTS,
  MIN_TITLE_WORDS,
  STOP,
  TITLE_CERTAIN,
  TITLE_FLOOR,
  mergeStories,
  shingle,
  splitRunawaysAsync,
  titleSimilarity,
  titleWords,
} from "./stories";

/**
 * The inbox pass: group everything related, deterministically, on request.
 *
 * Arrival-time grouping (lib/stories.ts) sees one article against the
 * stories that exist at that moment, headline first, before the article is
 * read. It is right to be conservative there. But by the time you sit down
 * to the inbox the articles are in, and five accounts of one hearing are
 * five decisions when they should be one. This pass reads the whole inbox
 * at once and folds what belongs together, by rules a person can follow,
 * with no model in the loop: the same inbox always groups the same way,
 * and running it again does nothing.
 *
 * What it had to learn first is that the "lede" of a fetched page is often
 * the site's chrome — "Now Playing · UP NEXT", the subscription box, a
 * think-tank's standing preamble — and two articles from that outlet then
 * share hundreds of words that have nothing to do with either. So the pass
 * strips what an outlet says in every article before it compares, using
 * the outlet's recent articles in the library, not just the ones in the
 * inbox today.
 */

export interface HeldAccount {
  sourceId: number;
  storyId: number | null;
  /** Who named the story it is in, so a story you named is never dissolved. */
  namedBy: "auto" | "user" | null;
  title: string;
  outlet: string;
  at: string;
  lede: string;
  summary: string;
}

/** Tags and entities out, whitespace folded: the text as prose. */
function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|quot|#39|lt|gt);/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The lede without its own headline, which many outlets repeat as the first line. */
export function withoutTitle(lede: string, title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  const l = lede.replace(/\s+/g, " ").trim();
  if (!t || !l) return l;
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const nt = norm(t);
  const head = norm(l.slice(0, t.length + 8));
  if (nt && head.startsWith(nt)) {
    // Walk forward past the title's words in the original.
    const words = nt.split(" ").length;
    return l.split(/\s+/).slice(words).join(" ");
  }
  return l;
}

/**
 * Word 4-grams of a text, the unit the wire-copy test is made of. Four words
 * is long enough that two articles sharing many of them share sentences,
 * not vocabulary.
 */
export function shingles4(text: string, maxWords = 160): Set<string> {
  const w = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords);
  const out = new Set<string>();
  for (let i = 0; i + 3 < w.length; i++) out.add(w.slice(i, i + 4).join(" "));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

const PHRASE_JOINERS = new Set(["of", "and", "the", "de", "du", "la", "le", "for", "&", "al", "bin", "von", "van"]);
/** A capitalised run longer than this is a headline or a caption, not a name. */
const MAX_PHRASE_WORDS = 5;

/**
 * The tokens that make an article specific: proper-name phrases and figures.
 *
 * A run of capitalised words is one name — "Immigration and Customs
 * Enforcement", "Scott Bessent" — and every two-word window of it is a
 * token too, so "FBI Director Kash Patel" in one account meets "Kash Patel"
 * in another. A single capitalised word counts only if the text also uses
 * it capitalised mid-sentence, which is what separates a proper noun from a
 * sentence opener. Figures count: "$5,000", "7-2", "$42 billion" are the
 * surest sign two headlines describe one thing; a bare year or a two-digit
 * number is not.
 */
export function specificTokens(text: string): Set<string> {
  const out = new Set<string>();
  const midCap = new Set<string>();
  const sentences = text.split(/(?<=[.!?؟])\s+|\n+/);
  for (const sentence of sentences) {
    const words = sentence.replace(/[^\p{L}\p{N}\s'’&-]/gu, " ").split(/\s+/).filter(Boolean);
    words.forEach((w, i) => {
      const raw = w.replace(/^['’]|['’]s?$/g, "");
      if (i > 0 && raw.length >= 2 && /^\p{Lu}/u.test(raw)) midCap.add(raw.toLowerCase());
    });
  }
  for (const sentence of sentences) {
    const words = sentence.replace(/[^\p{L}\p{N}\s'’&-]/gu, " ").split(/\s+/).filter(Boolean);
    let run: string[] = [];
    const flush = () => {
      while (run.length && PHRASE_JOINERS.has(run[run.length - 1])) run.pop();
      const cleaned = run.filter((w) => !PHRASE_JOINERS.has(w) && !STOP.has(w) && !COMMON_NAMES.has(w));
      run = [];
      if (!cleaned.length || cleaned.length > MAX_PHRASE_WORDS) return;
      if (cleaned.length === 1) {
        if (midCap.has(cleaned[0]) && cleaned[0].length > 3) out.add(cleaned[0]);
        return;
      }
      out.add(cleaned.join(" "));
      for (let i = 0; i + 1 < cleaned.length; i++) out.add(`${cleaned[i]} ${cleaned[i + 1]}`);
    };
    for (const w of words) {
      const raw = w.replace(/^['’]|['’]s?$/g, "");
      const cap = raw.length >= 2 && /^\p{Lu}/u.test(raw);
      const joiner = PHRASE_JOINERS.has(raw.toLowerCase()) && run.length > 0;
      if (cap || joiner) run.push(raw.toLowerCase());
      else if (run.length) flush();
    }
    if (run.length) flush();
  }
  for (const m of text.matchAll(/(?:\$|€|£)?\d[\d,]*(?:\.\d+)?(?:\s?(?:billion|million|bn|percent|%)|-\d+)?/gi)) {
    const t = m[0].replace(/\s+/g, " ").toLowerCase();
    const digits = t.replace(/\D/g, "");
    const marked = /[$€£%]|billion|million|bn|-/.test(t);
    if (!marked && digits.length < 3) continue;
    if (/^(19|20)\d{2}$/.test(digits) && !marked) continue;
    out.add(t);
  }
  return out;
}

/** What the grouping pass has read off one account. */
export interface Sketch {
  acc: HeldAccount;
  shingles: Set<string>;
  tokens: Set<string>;
}

/** An outlet's token or 4-gram in this many of its recent articles is its furniture. */
const FURNITURE_MIN = 3;
/** How many of an outlet's recent articles are read for its furniture. */
const FURNITURE_SAMPLE = 40;

/** The ledes of an outlet's recent articles in the library, for learning its furniture. */
function recentLedes(outlet: string): { title: string; lede: string }[] {
  const rows = db()
    .prepare(
      `SELECT s.title, (SELECT c.text FROM chunks c WHERE c.source_id = s.id ORDER BY c.seq LIMIT 1) AS lede
         FROM sources s WHERE s.outlet = ? AND s.kind = 'url'
        ORDER BY s.id DESC LIMIT ?`
    )
    .all(outlet, FURNITURE_SAMPLE) as { title: string; lede: string | null }[];
  return rows.filter((r): r is { title: string; lede: string } => Boolean(r.lede));
}

/** Marks a token that came from the headline's ordinary words, which count for less. */
export const TITLE_WORD = "~";

/** The headline's content words, as weaker tokens: "bombs", "impeach", "whiskey". */
export function titleWordTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)) {
    if (w.length > 3 && !STOP.has(w) && !COMMON_NAMES.has(w)) out.add(`${TITLE_WORD}${w}`);
  }
  return out;
}

function sketchOne(title: string, lede: string, summary: string): { shingles: Set<string>; tokens: Set<string> } {
  const body = withoutTitle(plain(lede).slice(0, 1800), title);
  const prose = `${body.slice(0, 1500)}\n${plain(summary).slice(0, 1200)}`;
  const tokens = new Set<string>();
  for (const t of specificTokens(prose)) tokens.add(t);
  // From the headline, Title Case makes every word a name: its figures
  // count as figures, its words as the weaker kind.
  for (const t of specificTokens(title)) if (/\d/.test(t)) tokens.add(t);
  for (const t of titleWordTokens(title)) tokens.add(t);
  return { shingles: shingles4(body.slice(0, 1200)), tokens };
}

/**
 * The shared tokens that say something on their own: a two-word window of
 * a longer shared phrase, or a headline word that is part of a shared
 * phrase, is the same evidence twice. "FBI Director Kash Patel", "Kash
 * Patel" and "patel" are one shared thing, not three.
 */
export function independent(shared: string[]): string[] {
  const bare = (t: string) => t.replace(TITLE_WORD, "");
  return shared.filter((t) => {
    const me = bare(t);
    return !shared.some((o) => {
      if (o === t) return false;
      const other = bare(o);
      // The same word as a headline word and as a name is one thing; the name wins.
      if (other === me) return t.startsWith(TITLE_WORD);
      return other.length > me.length && ` ${other} `.includes(` ${me} `);
    });
  });
}

/**
 * Reads every account and strips what its outlet says in every article,
 * then what the whole inbox says: a token in more than a few per cent of
 * the accounts is the beat, not a story.
 *
 * `furniture` may be supplied (outlet → recent ledes) so the rules can be
 * exercised without a database; by default it is read from the library.
 */
export function sketchAccounts(
  accounts: HeldAccount[],
  opts: { beatShare?: number; furniture?: (outlet: string) => { title: string; lede: string }[] } = {}
): Sketch[] {
  const raw: Sketch[] = accounts.map((acc) => ({ acc, ...sketchOne(acc.title, acc.lede, acc.summary) }));
  const learn = opts.furniture ?? recentLedes;

  const outlets = new Set(raw.map((r) => r.acc.outlet));
  for (const outlet of outlets) {
    const sample = learn(outlet);
    if (sample.length < FURNITURE_MIN) continue;
    const shingleDf = new Map<string, number>();
    const tokenDf = new Map<string, number>();
    for (const s of sample) {
      const sk = sketchOne(s.title, s.lede, "");
      for (const x of sk.shingles) shingleDf.set(x, (shingleDf.get(x) ?? 0) + 1);
      for (const t of sk.tokens) tokenDf.set(t, (tokenDf.get(t) ?? 0) + 1);
    }
    for (const r of raw) {
      if (r.acc.outlet !== outlet) continue;
      r.shingles = new Set([...r.shingles].filter((x) => (shingleDf.get(x) ?? 0) < FURNITURE_MIN));
      r.tokens = new Set([...r.tokens].filter((t) => (tokenDf.get(t) ?? 0) < FURNITURE_MIN));
    }
  }

  const df = new Map<string, number>();
  for (const r of raw) for (const t of r.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const beat = Math.max(4, Math.ceil(raw.length * (opts.beatShare ?? 0.03)));
  for (const r of raw) r.tokens = new Set([...r.tokens].filter((t) => (df.get(t) ?? 0) < beat));
  return raw;
}

export interface RelatedPair {
  a: number;
  b: number;
  why: "title" | "wire" | "tokens";
  score: number;
  shared: string[];
  /**
   * The model was shown a formed story as one line and put a headline with
   * it: the judgement was against the story as a whole, so the pair counts
   * as agreeing with every account at the story's core, not just the one
   * that stood for it.
   */
  whole?: boolean;
}

/** Titles alike; the same wire copy; or enough of the same specific tokens. */
export const RULES = {
  /** 4-gram overlap of two ledes from different outlets that says "same wire copy". */
  wireJaccard: 0.3,
  /** Independent shared tokens needed when the headlines resemble each other. */
  tokensWithTitle: 2,
  /** And when they do not. */
  tokensAlone: 3,
  /** The rarity-weighted share of the sparser account's tokens that must be shared. */
  score: 0.3,
  titleFloor: 0.2,
  hours: 72,
  hoursAlone: 48,
  /** How much a headline word weighs against a proper name or a figure. */
  titleWordWeight: 0.5,
};

/**
 * Every pair of accounts that are one story by the pass's rules.
 *
 * Tokens are weighted by rarity across the inbox — sharing "Kash Patel"
 * and "Senate Judiciary Committee" is worth more than sharing two tokens a
 * quarter of the inbox uses — and the score is the weighted overlap over
 * the union, so two thin wire items that share one name do not score as
 * one story. What settles it is how many independent things they share.
 */
export function relatedPairs(sketches: Sketch[], rules = RULES): RelatedPair[] {
  const out: RelatedPair[] = [];
  for (const _ of walkPairs(sketches, rules, out)) {
    // Run straight through.
  }
  return out;
}

/**
 * The same, giving the server's thread back every few milliseconds: the
 * walk over a full inbox takes half a minute, and pages must keep loading
 * while it runs.
 */
export async function relatedPairsAsync(
  sketches: Sketch[],
  rules = RULES,
  opts: { withinStories?: boolean } = {}
): Promise<RelatedPair[]> {
  const out: RelatedPair[] = [];
  for (const _ of walkPairs(sketches, rules, out, opts.withinStories ?? false)) await new Promise((r) => setImmediate(r));
  return out;
}

function* walkPairs(sketches: Sketch[], rules: typeof RULES, out: RelatedPair[], withinStories = false): Generator<void> {
  const n = sketches.length;
  const df = new Map<string, number>();
  for (const s of sketches) for (const t of s.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) =>
    (Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 0.1) * (t.startsWith(TITLE_WORD) ? rules.titleWordWeight : 1);
  const weights = sketches.map((s) => [...s.tokens].reduce((w, t) => w + idf(t), 0));

  // Everything a pair needs that belongs to one account is worked out once,
  // and accounts are walked in time order so each is only ever compared with
  // those inside the window after it. Comparing all with all — 41 million
  // pairs for a 9,000-item inbox, each re-reading both headlines — took four
  // and a half minutes on the server's only thread (17 Nov 2026).
  const times = sketches.map((s) => new Date(s.acc.at).getTime());
  const words = sketches.map((s) => new Set(titleWords(s.acc.title)));
  const order = sketches
    .map((_, i) => i)
    .filter((i) => Number.isFinite(times[i]))
    .sort((x, y) => times[x] - times[y] || sketches[x].acc.sourceId - sketches[y].acc.sourceId);
  const similarity = (x: number, y: number) => {
    const A = words[x];
    const B = words[y];
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const w of A) if (B.has(w)) shared++;
    return shared / Math.min(A.size, B.size);
  };
  const window = rules.hours * 3_600_000;

  let slice = Date.now();
  for (let oi = 0; oi < order.length; oi++) {
    if (Date.now() - slice > 30) {
      yield;
      slice = Date.now();
    }
    const i = order[oi];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      if (times[j] - times[i] > window) break;
      const A = sketches[i];
      const B = sketches[j];
      if (!withinStories && A.acc.storyId && A.acc.storyId === B.acc.storyId) continue;
      const apart = (times[j] - times[i]) / 3_600_000;
      const [a, b] = A.acc.sourceId < B.acc.sourceId ? [A.acc.sourceId, B.acc.sourceId] : [B.acc.sourceId, A.acc.sourceId];
      const ts = similarity(i, j);

      // titlesAgree(), from the words already in hand.
      if (Math.min(words[i].size, words[j].size) >= MIN_TITLE_WORDS && ts >= TITLE_CERTAIN) {
        out.push({ a, b, why: "title", score: ts, shared: [] });
        continue;
      }
      // The same wire copy under two headlines. Never within one outlet,
      // where identical ledes are the site's chrome, not a story.
      if (A.acc.outlet !== B.acc.outlet) {
        const wire = jaccard(A.shingles, B.shingles);
        if (wire >= rules.wireJaccard) {
          out.push({ a, b, why: "wire", score: wire, shared: [] });
          continue;
        }
      }
      const shared = independent([...A.tokens].filter((t) => B.tokens.has(t)));
      if (shared.length < rules.tokensWithTitle) continue;
      // Headline words alone — "despite", "warnings" — are not a story;
      // at least one shared name or figure has to be in it.
      if (!shared.some((t) => !t.startsWith(TITLE_WORD))) continue;
      const sharedWeight = shared.reduce((w, t) => w + idf(t), 0);
      // Against the sparser account: a long feature must not be able to
      // hide a shared event under its own length. Independence of the
      // shared tokens, checked above, is what keeps a thin pair honest.
      const score = sharedWeight / Math.max(0.1, Math.min(weights[i], weights[j]));
      if (score < rules.score) continue;
      const withTitle = ts >= rules.titleFloor;
      const alone = shared.length >= rules.tokensAlone && apart <= rules.hoursAlone;
      if (withTitle || alone) {
        out.push({ a, b, why: "tokens", score, shared: shared.sort() });
      }
    }
  }
}

/**
 * The accounts waiting in the inbox, oldest source first, with what the pass reads.
 *
 * With a bundle, only that bundle's. The event pass asks once per bundle, and
 * filtering the whole inbox each time read and sorted its full text — 67 MB in,
 * 26 MB out to a temp file — eighty-six times a pass, twice an hour (8 Nov 2026).
 * Asked per bundle rather than loaded once because the pass takes minutes:
 * a story merged or an item decided meanwhile must still be seen.
 */
export function heldAccounts(bundleId?: number): HeldAccount[] {
  const onlyBundle =
    bundleId === undefined
      ? ""
      : `AND s.id IN (SELECT held.source_id FROM inbox_bundle_items bi
                        JOIN feed_items held ON held.id = bi.item_id
                       WHERE bi.bundle_id = ?)`;
  return (
    db()
      .prepare(
        `SELECT s.id AS sourceId, ss.story_id AS storyId, st.named_by AS namedBy,
                i.title, COALESCE(s.outlet, f.outlet, f.title) AS outlet,
                COALESCE(i.published_at, s.published_at, i.seen_at) AS at,
                COALESCE((SELECT c.text FROM chunks c WHERE c.source_id = s.id ORDER BY c.seq LIMIT 1), '') AS lede,
                COALESCE(i.summary, '') AS summary
           FROM feed_items i
           JOIN feeds f ON f.id = i.feed_id
           JOIN sources s ON s.id = i.source_id
      LEFT JOIN story_sources ss ON ss.source_id = s.id
      LEFT JOIN stories st ON st.id = ss.story_id
          WHERE i.state = 'held' AND i.decided_at IS NULL
            ${onlyBundle}
          ORDER BY s.id`
      )
      .all(...(bundleId === undefined ? [] : [bundleId])) as HeldAccount[]
  ).map((a) => ({ ...a, title: a.title ?? "", outlet: a.outlet ?? "", lede: a.lede ?? "", summary: a.summary ?? "" }));
}

export interface GroupResult {
  accounts: number;
  pairs: number;
  grouped: number;
  stories: number;
  folded: number;
}

/**
 * Groups everything related in the inbox, and says what it did.
 *
 * A story you named yourself is a decision and is kept: other accounts may
 * join it, it never dissolves into another, and two stories you named are
 * never merged with each other.
 */
export function regroupHeld(): Promise<GroupResult> {
  // The pass now gives way to the server while it works, so a press of
  // "Group related" can arrive during the half-hourly one; it waits for that
  // pass rather than starting a second over the same stories.
  globalThis.__raaziRegroup ??= regroupOnce().finally(() => {
    globalThis.__raaziRegroup = undefined;
  });
  return globalThis.__raaziRegroup;
}

declare global {
  // eslint-disable-next-line no-var
  var __raaziRegroup: Promise<GroupResult> | undefined;
}

async function regroupOnce(): Promise<GroupResult> {
  // Anything that grew past one event — built by older rules, or by a path
  // this pass does not police — is taken apart and filed again first, so
  // the grouping below starts from stories that are each one thing.
  await splitRunawaysAsync({ inboxOnly: true });
  const accounts = heldAccounts();
  if (accounts.length < 2) return { accounts: accounts.length, pairs: 0, grouped: 0, stories: 0, folded: 0 };
  // Pairs inside stories too: they are what says a story's accounts belong.
  const pairs = await relatedPairsAsync(sketchAccounts(accounts), RULES, { withinStories: true });
  const trimmed = trimStrays(accounts, pairs);
  return applyGroups(trimmed, pairs);
}

/**
 * Takes out of each story the held accounts nothing ties to it.
 *
 * Kept: an account whose headline matches the story's own (TITLE_FLOOR), and
 * any account related to one of those by the pass's rules — one step from
 * the headline. What is further away arrived by a chain, the way "Jensen
 * Huang's affair" came to hold October's inflation figures, and leaves for a
 * story of its own; the grouping that follows may then put it with accounts
 * it does belong with. A story you named or pinned is never touched, and
 * only accounts still in the inbox are judged. Returns the accounts as they
 * now stand.
 */
export function trimStrays(accounts: HeldAccount[], pairs: RelatedPair[]): HeldAccount[] {
  const byStory = new Map<number, HeldAccount[]>();
  for (const a of accounts) if (a.storyId !== null) byStory.set(a.storyId, [...(byStory.get(a.storyId) ?? []), a]);
  const neighbours = new Map<number, Set<number>>();
  for (const p of pairs) {
    neighbours.set(p.a, (neighbours.get(p.a) ?? new Set()).add(p.b));
    neighbours.set(p.b, (neighbours.get(p.b) ?? new Set()).add(p.a));
  }
  const storyRow = db().prepare("SELECT title, named_by, pinned FROM stories WHERE id = ?");
  const reasonOf = db().prepare("SELECT reason FROM story_sources WHERE story_id = ? AND source_id = ?");
  // Filed on arrival by its headline against this story's, or placed by the
  // model under the core rule: tied to the story by something other than a
  // chain, though no pair below says so.
  const tiedByReason = (storyId: number, sourceId: number) => {
    const why = (reasonOf.get(storyId, sourceId) as { reason: string | null } | undefined)?.reason ?? "";
    return why.startsWith("Headline overlap") || why.startsWith(MODEL_CHECKED);
  };
  const firstOf = db().prepare(
    `SELECT ss.source_id AS id FROM story_sources ss JOIN sources s ON s.id = ss.source_id
      WHERE ss.story_id = ? ORDER BY COALESCE(s.published_at, s.added_at), s.id LIMIT 1`
  );
  const strays: { acc: HeldAccount; title: string }[] = [];
  for (const [storyId, members] of byStory) {
    if (members.length < 2) continue;
    const row = storyRow.get(storyId) as { title: string; named_by: string; pinned: number } | undefined;
    if (!row || row.named_by === "user" || row.pinned) continue;
    const opener = (firstOf.get(storyId) as { id: number } | undefined)?.id;
    const anchored = new Set(
      members
        .filter(
          (m) => m.sourceId === opener || titleSimilarity(m.title, row.title) >= TITLE_FLOOR || tiedByReason(storyId, m.sourceId)
        )
        .map((m) => m.sourceId)
    );
    for (const m of members) {
      if (anchored.has(m.sourceId)) continue;
      const near = neighbours.get(m.sourceId);
      if (near && [...near].some((id) => anchored.has(id))) continue;
      strays.push({ acc: m, title: row.title });
    }
  }
  if (!strays.length) return accounts;

  const moved = new Map<number, number>();
  tx(() => {
    const unlink = db().prepare("DELETE FROM story_sources WHERE source_id = ?");
    const open = db().prepare("INSERT INTO stories (title, shingle, first_seen, last_seen) VALUES (?, ?, ?, ?)");
    const link = db().prepare("INSERT INTO story_sources (story_id, source_id, reason) VALUES (?, ?, ?)");
    for (const { acc, title } of strays) {
      unlink.run(acc.sourceId);
      const id = Number(open.run(acc.title, shingle(acc.title), acc.at, acc.at).lastInsertRowid);
      link.run(id, acc.sourceId, `Taken out of "${title.slice(0, 80)}": nothing tied it to that story's headline.`);
      moved.set(acc.sourceId, id);
    }
  });
  console.log(`[corpus] inbox: took ${strays.length} unrelated account(s) out of the stories they had drifted into`);
  return accounts.map((a) => (moved.has(a.sourceId) ? { ...a, storyId: moved.get(a.sourceId)!, namedBy: "auto" } : a));
}

/**
 * How a grouping by the model under the core rule explains itself — and how
 * trimStrays knows not to undo it. Older groupings by the model say "on
 * headlines" and are judged like any other.
 */
const MODEL_CHECKED = "Grouped in the inbox by the model, checked against the story";

/** How many of a cluster's earliest accounts a newcomer is measured against. */
export const CORE = 6;
/** The share of the core a newcomer (or a whole cluster) has to agree with. */
export const CORE_SHARE = 0.5;
/** The widest one event's held accounts may be spread, in hours. */
export const EVENT_HOURS = 72;

const PAIR_TIER = { title: 0, wire: 1, tokens: 2 } as const;

/**
 * Merges the clusters the pairs describe. Separate so the rules can be tested apart from the writes.
 *
 * Not a chain. This used to join every pair it was given (union-find), so
 * one account resembling two others made all three one story, and a pass
 * over nine thousand held accounts linked them into piles of hundreds — a
 * story of 659 accounts by 17 November 2026, from Iran's supreme leader to
 * the Michigan Senate race. Now clusters grow strongest pair first, and two
 * clusters join only when:
 *
 *  - at least half the pairs between their cores are related (the core is
 *    a cluster's first CORE accounts, oldest first), so a newcomer has to
 *    agree with what the event IS, not with whichever account it touches;
 *  - they are not two stories already formed — folding stories is
 *    regroupRecent's job, on its stricter headline rule;
 *  - together they stay within EVENT_HOURS and MAX_STORY_ACCOUNTS.
 *
 * Missing a join leaves a story split, which is one click from fixed; a
 * wrong join hides accounts inside a story, which nobody sees.
 */
export function applyGroups(accounts: HeldAccount[], pairs: RelatedPair[]): GroupResult {
  const bySource = new Map(accounts.map((a) => [a.sourceId, a]));
  const ms = (iso: string) => {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : NaN;
  };

  // A story is "formed" — a unit that is never folded into another here —
  // once it has a second account anywhere (held or decided), or you named it.
  // A story of one is just where a lone account was filed.
  const totals = new Map<number, number>();
  {
    const count = db().prepare("SELECT COUNT(*) AS n FROM story_sources WHERE story_id = ?");
    for (const a of accounts) {
      if (a.storyId !== null && !totals.has(a.storyId)) totals.set(a.storyId, (count.get(a.storyId) as { n: number }).n);
    }
  }
  const formed = (a: HeldAccount) => a.storyId !== null && (a.namedBy === "user" || (totals.get(a.storyId) ?? 0) > 1);

  interface Cluster {
    members: HeldAccount[];
    /** The formed story this cluster is built on, if any. */
    story: number | null;
    named: boolean;
    /** Accounts in the formed story beyond the held ones here. */
    outside: number;
    first: number;
    last: number;
  }
  const clusterOf = new Map<number, Cluster>();
  const byStory = new Map<number, Cluster>();
  for (const a of [...accounts].sort((x, y) => x.at.localeCompare(y.at) || x.sourceId - y.sourceId)) {
    const t = ms(a.at);
    if (formed(a)) {
      let c = byStory.get(a.storyId!);
      if (!c) {
        c = { members: [], story: a.storyId, named: false, outside: totals.get(a.storyId!) ?? 0, first: t, last: t };
        byStory.set(a.storyId!, c);
      }
      c.members.push(a);
      c.outside--;
      c.named ||= a.namedBy === "user";
      c.first = Math.min(c.first, t);
      c.last = Math.max(c.last, t);
      clusterOf.set(a.sourceId, c);
    } else {
      clusterOf.set(a.sourceId, { members: [a], story: null, named: false, outside: 0, first: t, last: t });
    }
  }

  const key = (x: number, y: number) => (x < y ? `${x}-${y}` : `${y}-${x}`);
  const related = new Set<string>();
  /** Accounts a "whole story" pair vouches for: every core account of that story. */
  const wholeWith = new Map<number, Set<number>>();
  for (const p of pairs) {
    related.add(key(p.a, p.b));
    if (p.whole) {
      for (const [lone, rep] of [[p.a, p.b], [p.b, p.a]]) {
        const c = clusterOf.get(rep);
        if (c?.story != null) wholeWith.set(lone, new Set([...(wholeWith.get(lone) ?? []), ...c.members.map((m) => m.sourceId)]));
      }
    }
  }
  const agree = (x: number, y: number) => related.has(key(x, y)) || wholeWith.get(x)?.has(y) || wholeWith.get(y)?.has(x);
  const core = (c: Cluster) => c.members.slice(0, CORE).map((m) => m.sourceId);

  const mayJoin = (X: Cluster, Y: Cluster): boolean => {
    if (X === Y) return false;
    if (X.story !== null && Y.story !== null) return false;
    if (X.named && Y.named) return false;
    const held = X.members.length + Y.members.length;
    if (held + X.outside + Y.outside > MAX_STORY_ACCOUNTS) return false;
    const first = Math.min(X.first, Y.first);
    const last = Math.max(X.last, Y.last);
    if (Number.isFinite(first) && Number.isFinite(last) && (last - first) / 3_600_000 > EVENT_HOURS) return false;
    const cx = core(X);
    const cy = core(Y);
    let agreeing = 0;
    for (const x of cx) for (const y of cy) if (agree(x, y)) agreeing++;
    return agreeing >= Math.max(1, Math.ceil(cx.length * cy.length * CORE_SHARE));
  };
  const join = (X: Cluster, Y: Cluster) => {
    // The cluster built on a formed story absorbs the other, so its id survives.
    const [into, from] = Y.story !== null ? [Y, X] : [X, Y];
    into.members = [...into.members, ...from.members].sort((x, y) => x.at.localeCompare(y.at) || x.sourceId - y.sourceId);
    into.first = Math.min(into.first, from.first);
    into.last = Math.max(into.last, from.last);
    into.named ||= from.named;
    for (const m of from.members) clusterOf.set(m.sourceId, into);
  };
  // Why each account was grouped, so a wrong grouping is explicable from
  // the story page: the first pair that reached it says.
  const because = new Map<number, string>();
  const explain = (p: RelatedPair) =>
    p.why === "title"
      ? "Grouped in the inbox: the headlines match."
      : p.why === "wire"
        ? "Grouped in the inbox: the same wire copy."
        : p.shared[0]?.startsWith("model: ")
          ? `${MODEL_CHECKED}${p.shared[0].length > 7 ? ` — ${p.shared[0].slice(7)}` : ""}.`
          : `Grouped in the inbox: shares ${p.shared.map((s) => s.replace(TITLE_WORD, "")).slice(0, 4).join(", ")}.`;
  // Strongest evidence first — matching headlines, then shared wire copy,
  // then shared names by score — so a cluster's core is made of its surest
  // accounts before anything weaker is measured against it. Ties by id, so
  // the same inbox always groups the same way.
  const ordered = [...pairs].sort(
    (x, y) => PAIR_TIER[x.why] - PAIR_TIER[y.why] || y.score - x.score || x.a - y.a || x.b - y.b
  );
  for (const p of ordered) {
    if (!bySource.has(p.a) || !bySource.has(p.b)) continue;
    const X = clusterOf.get(p.a)!;
    const Y = clusterOf.get(p.b)!;
    if (!mayJoin(X, Y)) continue;
    for (const id of [p.a, p.b]) if (!because.has(id)) because.set(id, explain(p));
    join(X, Y);
  }

  const clusters = [...new Set(clusterOf.values())]
    .filter((c) => c.members.length > 1 && !(c.story !== null && c.members.every((m) => m.storyId === c.story)))
    .sort((x, y) => x.members[0].sourceId - y.members[0].sourceId);

  let grouped = 0;
  let stories = 0;
  let folded = 0;
  tx(() => {
    const link = db().prepare("INSERT OR IGNORE INTO story_sources (story_id, source_id, reason) VALUES (?, ?, ?)");
    const touch = db().prepare("UPDATE stories SET last_seen = MAX(last_seen, ?) WHERE id = ?");
    const reason = db().prepare("UPDATE story_sources SET reason = ? WHERE story_id = ? AND source_id = ?");
    for (const c of clusters) {
      // Built on a formed story: that story. Otherwise the story the earliest
      // account was filed under, so its headline names the event.
      const first = c.members[0];
      let keep: number;
      if (c.story !== null) keep = c.story;
      else if (first.storyId !== null) keep = first.storyId;
      else {
        keep = Number(
          db()
            .prepare("INSERT INTO stories (title, shingle, first_seen, last_seen) VALUES (?, ?, ?, ?)")
            .run(first.title, shingle(first.title), first.at, first.at).lastInsertRowid
        );
      }
      for (const m of c.members) {
        if (m.storyId === keep) continue;
        const why = because.get(m.sourceId) ?? "Grouped with the inbox's related accounts.";
        if (m.storyId !== null) {
          // A story of one: where this account was filed alone. Folding it
          // moves the account and retires the empty story.
          mergeStories(keep, m.storyId);
          reason.run(why, keep, m.sourceId);
          folded++;
        } else {
          link.run(keep, m.sourceId, why);
        }
        touch.run(m.at, keep);
        grouped++;
      }
      stories++;
    }
  });
  if (grouped) console.log(`[corpus] inbox: grouped ${grouped} account(s) into ${stories} stor${stories === 1 ? "y" : "ies"}, folding ${folded}`);
  return { accounts: accounts.length, pairs: pairs.length, grouped, stories, folded };
}

// ---------------------------------------------------------------------------
// The model's pass: headlines only, the cheapest model, under the same guards
// ---------------------------------------------------------------------------

/**
 * What the rules cannot see, a small model can: that "Court lifts a cloud
 * over the midterms" and "Trump slams justices over ballots" are one story,
 * with no name or figure in common. So after the rules have done what they
 * can, the headlines that are still alone — and one line for each story
 * already formed — go to the cheapest model on the ring (or the local one,
 * if the "Grouping the inbox" stage is routed there), which reads nothing
 * but headlines and says which belong together. A few thousand tokens.
 *
 * The model proposes; the rules dispose. A group it returns is applied only
 * if every member is in the inbox, its accounts fall within a few days of
 * each other, it is not absurdly large, and it does not fold two stories
 * that already exist. Then it goes through applyGroups like any other
 * pairing, so a story you named is as safe from the model as from the rules.
 */
const GROUP_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    groups: {
      type: Type.ARRAY,
      description: "Sets of headlines that report one event or development. Leave out anything that stands alone.",
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING, description: "The story in a few words." },
          ids: { type: Type.ARRAY, items: { type: Type.STRING }, description: "The ids of the headlines, at least two." },
        },
        required: ["ids"],
      },
    },
  },
  required: ["groups"],
};

const GROUP_SYSTEM = `You group news headlines for a journalist's inbox, so that every account of one
event is read once. You see only headlines, each with an outlet and a time.

- A group is accounts of the SAME event or development: the same ruling, the
  same hearing, the same announcement, the same report. Several outlets
  covering one thing; a follow-up the same day; a reaction piece to it.
- The same subject is NOT the same event. Five pieces about one senator in
  a week are five stories unless they report one thing he did. Two pieces
  on "AI regulation" are two stories unless they cover the same hearing,
  bill or statement.
- Ids beginning with S are stories already formed; the line shows the
  story's headline and how many accounts it has. Attach a lone headline to
  one of them when it is the same event. Never put two S ids in one group.
- Leave out everything that stands alone. An empty list is a fine answer.
- Return ids exactly as given.`;

/** The most a model-proposed group may hold; past this it is a subject, not a story. */
const MAX_MODEL_GROUP = 10;
/** How far apart the accounts of a model-proposed group may be published. */
const MODEL_GROUP_HOURS = 96;

export interface ModelGroupResult extends GroupResult {
  /** Which model answered, or null when none could. */
  model: string | null;
  /** What went wrong, when nothing answered. */
  error: string | null;
  /** How many of its groups the guards let through. */
  proposed: number;
  accepted: number;
}

/**
 * The lines the model reads: one per lone headline, one per story that
 * already has more than one held account.
 */
export function headlineLines(accounts: HeldAccount[]): { lines: string[]; storyRep: Map<number, number> } {
  const byStory = new Map<number, HeldAccount[]>();
  for (const a of accounts) if (a.storyId !== null) byStory.set(a.storyId, [...(byStory.get(a.storyId) ?? []), a]);
  const when = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(5, 16).replace("T", " ");
  };
  const lines: string[] = [];
  const storyRep = new Map<number, number>();
  const seenStory = new Set<number>();
  for (const a of [...accounts].sort((x, y) => x.at.localeCompare(y.at) || x.sourceId - y.sourceId)) {
    const mates = a.storyId !== null ? byStory.get(a.storyId) ?? [] : [];
    if (a.storyId !== null && mates.length > 1) {
      if (seenStory.has(a.storyId)) continue;
      seenStory.add(a.storyId);
      storyRep.set(a.storyId, a.sourceId);
      lines.push(`S${a.storyId}: ${a.title.replace(/\s+/g, " ").trim()} — ${mates.length} accounts, ${when(a.at)}`);
    } else {
      lines.push(`I${a.sourceId}: ${a.title.replace(/\s+/g, " ").trim()} — ${a.outlet}, ${when(a.at)}`);
    }
  }
  return { lines, storyRep };
}

/**
 * The pairs a model's answer amounts to, after the guards. Pure, so it can
 * be tested with a made-up answer.
 */
export function pairsFromModel(
  accounts: HeldAccount[],
  storyRep: Map<number, number>,
  groups: { label?: string; ids?: string[] }[]
): { pairs: RelatedPair[]; accepted: number } {
  const bySource = new Map(accounts.map((a) => [a.sourceId, a]));
  const pairs: RelatedPair[] = [];
  let accepted = 0;
  for (const g of groups ?? []) {
    const members: number[] = [];
    let stories = 0;
    for (const raw of g.ids ?? []) {
      const m = /^([SI])(\d+)$/.exec(String(raw).trim());
      if (!m) continue;
      if (m[1] === "S") {
        const rep = storyRep.get(Number(m[2]));
        if (rep === undefined) continue;
        stories++;
        members.push(rep);
      } else if (bySource.has(Number(m[2]))) {
        members.push(Number(m[2]));
      }
    }
    const unique = [...new Set(members)];
    if (unique.length < 2 || unique.length > MAX_MODEL_GROUP || stories > 1) continue;
    const times = unique.map((id) => new Date(bySource.get(id)!.at).getTime()).filter((t) => Number.isFinite(t));
    if (times.length && (Math.max(...times) - Math.min(...times)) / 3_600_000 > MODEL_GROUP_HOURS) continue;
    accepted++;
    // Every member with every other: the model said they are all one event,
    // and applyGroups asks a newcomer to agree with most of a cluster's core,
    // which a star around the first member would never satisfy. A pair with
    // the account standing for a formed story vouches for the whole story.
    const reps = new Set(storyRep.values());
    for (let x = 0; x < unique.length; x++) {
      for (let y = x + 1; y < unique.length; y++) {
        const [a, b] = [Math.min(unique[x], unique[y]), Math.max(unique[x], unique[y])];
        pairs.push({
          a,
          b,
          why: "tokens",
          score: 1,
          shared: [`model: ${(g.label ?? "").slice(0, 60)}`],
          ...(reps.has(a) || reps.has(b) ? { whole: true } : {}),
        });
      }
    }
  }
  return { pairs, accepted };
}

/**
 * Asks the model about what the rules left alone, and applies what passes.
 * Never throws: an inbox that could not be grouped by the model is still an
 * inbox, and the result says what happened.
 */
export async function regroupByHeadlines(opts: { timeoutMs?: number } = {}): Promise<ModelGroupResult> {
  const nothing: ModelGroupResult = { accounts: 0, pairs: 0, grouped: 0, stories: 0, folded: 0, model: null, error: null, proposed: 0, accepted: 0 };
  const accounts = heldAccounts();
  if (accounts.length < 2) return { ...nothing, accounts: accounts.length };
  const { lines, storyRep } = headlineLines(accounts);
  if (lines.length < 2) return { ...nothing, accounts: accounts.length };

  let data: { groups?: { label?: string; ids?: string[] }[] };
  let model: string | null = null;
  try {
    const res = await generateJson<{ groups?: { label?: string; ids?: string[] }[] }>({
      stage: "group",
      system: GROUP_SYSTEM,
      schema: GROUP_SCHEMA,
      temperature: 0,
      timeoutMs: opts.timeoutMs ?? 120_000,
      parts: [`HEADLINES (${lines.length}), oldest first:\n${lines.join("\n")}`],
    });
    data = res.data;
    model = res.model ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[corpus] inbox: the model could not group headlines — ${message}`);
    return { ...nothing, accounts: accounts.length, error: message.slice(0, 200) };
  }

  const { pairs, accepted } = pairsFromModel(accounts, storyRep, data.groups ?? []);
  const applied = applyGroups(accounts, pairs);
  return { ...applied, model, error: null, proposed: (data.groups ?? []).length, accepted };
}

/** The whole pass: the rules first, then the model on what they left alone. */
export async function regroupInbox(): Promise<{ rules: GroupResult; model: ModelGroupResult }> {
  const rules = await regroupHeld();
  const model = await regroupByHeadlines();
  return { rules, model };
}
