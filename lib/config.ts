import { readStore, writeStore } from "./config-file";
import { publicKeys } from "./keys";
import type { ProviderId, Stage } from "./providers";


export interface Config {
  /**
   * Which provider handles each stage. Absent means Gemini. The point of this
   * is `extract`: it is ~88% of all tokens and needs nothing but text, so
   * moving it is what makes a free Gemini quota last.
   */
  routing: Partial<Record<Stage, ProviderId>>;
  /** How long a key sits out after a quota refusal before it is tried again.
   *  Doubles on each consecutive refusal, so a genuinely spent day settles. */
  keyRetryMinutes: number;
  model: string;
  embedModel: string;
  /** Free-tier keys have far tighter RPM; the worker paces itself off this. */
  tier: "free" | "paid";
  requestsPerMinute: number;
  /** Auto-generate an entry once an entity has at least this many mentions. */
  entryThreshold: number;
  /** Rewrite entries that new evidence has left out of date, without asking.
   *  Entries that already exist are refreshed whatever their size; the
   *  threshold above only governs whether a *first* entry gets written. */
  autoRefreshEntries: boolean;
  /** Run the morning routine (rewrite multi-flagged entries, hunt pictures). */
  morningChores: boolean;
  /** Local hour the routine becomes due. "Seven" means the first chance after seven. */
  morningHour: number;
  /** The last day the routine ran, YYYY-MM-DD local. State, not a setting. */
  lastChores: string;
  /** Default token cap per run. 0 = uncapped. */
  defaultBudget: number;
  /**
   * The language entries and briefs are written in, as a BCP-47 primary tag.
   * Quotes stay verbatim in their own language whatever this says. Entries
   * used to follow the language of their evidence, which in a bilingual
   * library produced entries that switched language between paragraphs.
   */
  entryLanguage: string;
  /** Poll the feeds you follow while the app is running. */
  feedPolling: boolean;
  /**
   * Hold what the feeds pull in until you have looked at it.
   *
   * On, an article is fetched and chunked — both free — and then waits in the
   * inbox; keeping it is what starts the reading. Off is the old behaviour,
   * where every article a feed carried was read in full on arrival. For a beat
   * that is most of a wire service's day, at the most expensive stage there is.
   */
  feedReview: boolean;
  /**
   * Write a brief each day, once the morning's feeds are in.
   *
   * With `feedReview` on this waits for an empty inbox: a brief written over
   * articles you have not looked at yet is a brief about a fraction of the
   * morning, and it would be the one you read.
   */
  dailyBrief: boolean;
  /** How many hours back a brief looks. A day, unless you read less often. */
  briefHours: number;
}

const DEFAULTS: Config = {
  routing: {},
  keyRetryMinutes: 60,
  model: "gemini-flash-latest",
  embedModel: "gemini-embedding-001",
  tier: "free",
  requestsPerMinute: 10,
  entryThreshold: 3,
  autoRefreshEntries: true,
  morningChores: true,
  morningHour: 7,
  lastChores: "",
  defaultBudget: 0,
  entryLanguage: "en",
  feedPolling: true,
  feedReview: true,
  dailyBrief: true,
  briefHours: 24,
};

export function getConfig(): Config {
  // API keys are not part of this — they live on the ring in lib/keys.ts,
  // which owns their per-key state as well as their values. Both read and
  // write the same file through lib/config-file.ts, which is what makes the
  // writes atomic and a corrupt file recoverable instead of silently empty.
  return { ...DEFAULTS, ...readStore<Config>() };
}

export function saveConfig(patch: Partial<Config>): Config {
  writeStore({ ...readStore(), ...patch });
  return getConfig();
}

/** Never send key values to the browser; the UI gets masked hints only. */
export function publicConfig() {
  const c = getConfig();
  return {
    keys: publicKeys(),
    routing: c.routing,
    keyRetryMinutes: c.keyRetryMinutes,
    model: c.model,
    embedModel: c.embedModel,
    tier: c.tier,
    requestsPerMinute: c.requestsPerMinute,
    entryThreshold: c.entryThreshold,
    autoRefreshEntries: c.autoRefreshEntries,
    defaultBudget: c.defaultBudget,
    morningChores: c.morningChores,
    morningHour: c.morningHour,
    entryLanguage: c.entryLanguage,
    feedPolling: c.feedPolling,
    feedReview: c.feedReview,
    dailyBrief: c.dailyBrief,
    briefHours: c.briefHours,
  };
}
