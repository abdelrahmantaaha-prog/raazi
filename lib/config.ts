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
  /**
   * Where non-Latin sources go regardless of the routing above. The free
   * alternatives are appreciably weaker on Arabic, and a missed name is a
   * silent loss rather than a slow one.
   */
  nonLatinProvider: ProviderId;
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
}

const DEFAULTS: Config = {
  routing: {},
  nonLatinProvider: "gemini",
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
    nonLatinProvider: c.nonLatinProvider,
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
  };
}
