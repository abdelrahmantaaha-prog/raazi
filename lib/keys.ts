import crypto from "node:crypto";
import { readStore, writeStore } from "./config-file";
import { spec, type ProviderId } from "./providers";
import { brokerKeys, isBrokerKey, patchBrokerKey } from "./broker";

/**
 * The key ring.
 *
 * A free key runs out of quota long before a book is finished. With several
 * keys the run does not have to stop: the refused one is set aside and the next
 * picks the work straight up. The run only parks when every key is spent, and
 * then until the *earliest* one returns rather than the last.
 *
 * A key set aside is not written off for the day — see markExhausted. Providers
 * describe a spent minute and a spent day almost identically, so the wait starts
 * at an hour and only lengthens if the key is refused again.
 *
 * Keys live in data/config.json alongside the rest of the settings. Their state
 * lives there too, so a restart still knows which ones are spent.
 */

export interface ApiKey {
  id: string;
  label: string;
  key: string;
  /** Which service this key opens. Absent on keys written before Corpus could
   *  talk to more than one, which is why every read defaults it to gemini. */
  provider?: ProviderId;
  /** Overrides the provider's default model for this key. */
  model?: string;
  /** For self-hosted OpenAI-compatible endpoints. */
  baseUrl?: string;
  /** Set aside by you. */
  disabled?: boolean;
  /** Refused on quota; unusable until this time. See markExhausted. */
  exhaustedUntil?: string | null;
  /** Short per-minute rate-limit backoff. */
  cooldownUntil?: string | null;
  /** The provider rejected it. Needs your attention; never retried automatically. */
  invalid?: boolean;
  /** Consecutive quota refusals, which lengthen the wait before trying again.
   *  Cleared by any successful call. */
  quotaStrikes?: number;
  /** The same, for short rate-limit waits. */
  coolStrikes?: number;
  lastError?: string | null;
  calls?: number;
  tokensIn?: number;
  tokensOut?: number;
}


interface Stored {
  keys?: ApiKey[];
  /** The single key this app used before it could hold several. */
  apiKey?: string;
  [k: string]: unknown;
}

// Shared with lib/config.ts. The ring is rewritten after every model call,
// which is exactly why these must be the atomic, quarantining versions in
// lib/config-file.ts — a torn write followed by a swallowed parse error was
// enough to persist an empty ring over all thirty-seven keys.
const read = (): Stored => readStore<Stored>();
const write = (next: Stored): void => writeStore(next);

const newId = () => crypto.randomBytes(6).toString("hex");

/**
 * Reads the ring, folding in the legacy single key and the environment
 * variable. The env key is listed first and never written to disk.
 */
export function listKeys(): ApiKey[] {
  const stored = read();
  const keys: ApiKey[] = [...(stored.keys ?? [])];

  // Upgrade a config written before the ring existed.
  if (stored.apiKey?.trim() && !keys.some((k) => k.key === stored.apiKey!.trim())) {
    const migrated: ApiKey = {
      id: newId(),
      label: "Key 1",
      key: stored.apiKey.trim(),
      provider: "gemini",
    };
    keys.unshift(migrated);
    write({ ...stored, keys, apiKey: undefined });
  }

  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey && !keys.some((k) => k.key === envKey)) {
    keys.unshift({ id: "env", label: "From GEMINI_API_KEY", key: envKey, provider: "gemini" });
  }
  // The shared pool goes in front of everything: it rotates thirty-seven keys
  // and knows what the other apps have already spent. These keys are on this
  // machine, and they are the fallback for when the broker cannot be reached.
  return [...brokerKeys(), ...keys].map((k) => ({ ...k, provider: k.provider ?? "gemini" }));
}

/** Keys that are genuinely this machine's — the broker is not one of them, and
 *  neither surface can upload a file that the other can then read. */
export function localKeys(provider?: ProviderId): ApiKey[] {
  return usableKeys(provider).filter((k) => !isBrokerKey(k.id));
}

function persist(keys: ApiKey[]) {
  const stored = read();
  // The environment key is not ours to save, and neither is the broker's.
  write({
    ...stored,
    keys: keys.filter((k) => k.id !== "env" && !isBrokerKey(k.id)),
    apiKey: undefined,
  });
}

function update(id: string, patch: Partial<ApiKey>) {
  // The broker's state is a fact about the network, not about a key you own;
  // it is remembered for this process and forgotten on restart.
  if (isBrokerKey(id)) {
    patchBrokerKey(id, patch);
    return;
  }
  const keys = listKeys().map((k) => (k.id === id ? { ...k, ...patch } : k));
  persist(keys);
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const past = (iso?: string | null) => !iso || new Date(iso).getTime() <= Date.now();

const onProvider = (keys: ApiKey[], provider?: ProviderId) =>
  provider ? keys.filter((k) => k.provider === provider) : keys;

/** Usable right now: enabled, not rejected, quota not spent, not cooling down. */
export function usableKeys(provider?: ProviderId): ApiKey[] {
  return onProvider(
    listKeys().filter(
      (k) => !k.disabled && !k.invalid && past(k.exhaustedUntil) && past(k.cooldownUntil)
    ),
    provider
  );
}

/** Enabled and not rejected — may still be waiting on a quota reset. */
export function liveKeys(provider?: ProviderId): ApiKey[] {
  return onProvider(
    listKeys().filter((k) => !k.disabled && !k.invalid),
    provider
  );
}

/** `prefer` pins a particular key when it is still usable — the Files API hands
 *  back a URI only the uploading key can read, so that call and the one that
 *  reads the file have to agree on which key they are. */
export function nextKey(
  provider?: ProviderId,
  exclude: Set<string> = new Set(),
  prefer?: string
): ApiKey | undefined {
  const free = usableKeys(provider).filter((k) => !exclude.has(k.id));
  return (prefer ? free.find((k) => k.id === prefer) : undefined) ?? free[0];
}

export function hasUsableKey(provider?: ProviderId): boolean {
  return usableKeys(provider).length > 0;
}

/** Which providers you have at least one working key for. */
export function configuredProviders(): ProviderId[] {
  return [...new Set(listKeys().map((k) => k.provider ?? "gemini"))];
}

export function modelFor(key: ApiKey): string {
  return key.model?.trim() || spec(key.provider ?? "gemini").defaultModel;
}

/**
 * When every key is spent, this is when the first one comes back — the run
 * should sleep until then, not until the last one resets.
 */
export function earliestReset(provider?: ProviderId): Date | undefined {
  const waiting = liveKeys(provider)
    .map((k) => k.exhaustedUntil ?? k.cooldownUntil)
    .filter((t): t is string => Boolean(t) && !past(t))
    .map((t) => new Date(t).getTime());
  return waiting.length ? new Date(Math.min(...waiting)) : undefined;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/**
 * Sets a key aside after a quota refusal.
 *
 * Not until tomorrow: providers report a spent minute and a spent day in
 * indistinguishable ways, and parking a key for eighteen hours over a
 * per-minute burst wastes most of a free tier. Instead the key comes back after
 * an hour by default, and only if it is refused *again* on its first call back
 * does the wait double — so a genuinely spent day settles down on its own
 * rather than being retried sixteen times.
 *
 * A single successful call clears the count.
 */
export function markExhausted(id: string, reason: string, retryMinutes = 60) {
  const key = listKeys().find((k) => k.id === id);
  const strikes = (key?.quotaStrikes ?? 0) + 1;
  const minutes = Math.min(retryMinutes * 2 ** (strikes - 1), MAX_BACKOFF_MINUTES);

  update(id, {
    exhaustedUntil: new Date(Date.now() + minutes * 60_000).toISOString(),
    quotaStrikes: strikes,
    lastError: `${reason} Trying again in ${describeMinutes(minutes)}.`,
  });
}

/** Eight hours is long enough that a truly spent day costs three wasted calls. */
const MAX_BACKOFF_MINUTES = 8 * 60;

function describeMinutes(m: number): string {
  if (m < 60) return `${m} minutes`;
  const h = Math.round(m / 60);
  return h === 1 ? "an hour" : `${h} hours`;
}

/**
 * A short rate-limit wait, lengthening while the key keeps refusing.
 *
 * A genuine per-minute limit clears on the first retry, so the common case is
 * unaffected. What this stops is the other case: a key that is actually spent
 * but reports it without saying so keeps asking to be retried in a minute, and
 * a ring of a dozen such keys will poll all night for nothing. The wait doubles
 * on each consecutive refusal — capped well short of the quota backoff, since
 * this is still assumed to be a passing window — and any success clears it.
 */
export function markCooldown(id: string, ms: number, reason: string) {
  const key = listKeys().find((k) => k.id === id);
  const strikes = (key?.coolStrikes ?? 0) + 1;
  const wait = Math.min(ms * 2 ** (strikes - 1), MAX_COOLDOWN_MS);

  update(id, {
    cooldownUntil: new Date(Date.now() + wait).toISOString(),
    coolStrikes: strikes,
    lastError:
      strikes > 2 ? `${reason} Backing off to ${Math.round(wait / 60_000)} min.` : reason,
  });
}

/** Half an hour. Long enough to stop the polling, short enough that a key
 *  which really was only busy is not left idle for long. */
const MAX_COOLDOWN_MS = 30 * 60_000;

export function markInvalid(id: string, reason: string) {
  update(id, { invalid: true, lastError: reason });
}

export function markUsed(id: string, tokensIn: number, tokensOut: number) {
  const key = listKeys().find((k) => k.id === id);
  if (!key) return;
  update(id, {
    calls: (key.calls ?? 0) + 1,
    tokensIn: (key.tokensIn ?? 0) + tokensIn,
    tokensOut: (key.tokensOut ?? 0) + tokensOut,
    // A call that worked clears whatever was wrong before, including the
    // escalating quota backoff — the next refusal starts from one hour again.
    lastError: null,
    cooldownUntil: null,
    quotaStrikes: 0,
    coolStrikes: 0,
  });
}

// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------

export function addKey(
  key: string,
  label?: string,
  opts: { provider?: ProviderId; model?: string; baseUrl?: string } = {}
): ApiKey {
  const clean = key.trim();
  const provider = opts.provider ?? "gemini";
  const keys = listKeys().filter((k) => k.id !== "env");

  const existing = keys.find((k) => k.key === clean && (k.provider ?? "gemini") === provider);
  if (existing) {
    // Re-adding a key is how you say "try this one again".
    update(existing.id, { invalid: false, disabled: false, exhaustedUntil: null, cooldownUntil: null, lastError: null });
    return existing;
  }

  const sameProvider = keys.filter((k) => (k.provider ?? "gemini") === provider);
  const added: ApiKey = {
    id: newId(),
    label: label?.trim() || `${spec(provider).label} key ${sameProvider.length + 1}`,
    key: clean,
    provider,
    ...(opts.model?.trim() ? { model: opts.model.trim() } : {}),
    ...(opts.baseUrl?.trim() ? { baseUrl: opts.baseUrl.trim() } : {}),
  };
  persist([...keys, added]);
  return added;
}

export function removeKey(id: string) {
  persist(listKeys().filter((k) => k.id !== id && k.id !== "env"));
}

export function setKey(
  id: string,
  patch: { label?: string; disabled?: boolean; model?: string; baseUrl?: string }
) {
  const clean: Partial<ApiKey> = {};
  if (patch.label !== undefined) clean.label = patch.label.trim() || undefined;
  if (patch.disabled !== undefined) clean.disabled = patch.disabled;
  if (patch.model !== undefined) clean.model = patch.model.trim() || undefined;
  if (patch.baseUrl !== undefined) clean.baseUrl = patch.baseUrl.trim() || undefined;
  update(id, clean);
}

/** Clears quota/rejection state so a key is tried again right now. */
export function reviveKey(id: string) {
  update(id, {
    invalid: false,
    exhaustedUntil: null,
    cooldownUntil: null,
    lastError: null,
    quotaStrikes: 0,
    coolStrikes: 0,
  });
}

export type KeyStatus = "active" | "waiting" | "rejected" | "off";

export function statusOf(k: ApiKey): KeyStatus {
  if (k.disabled) return "off";
  if (k.invalid) return "rejected";
  if (!past(k.exhaustedUntil) || !past(k.cooldownUntil)) return "waiting";
  return "active";
}

/** Everything the browser is allowed to know — never the key itself. */
export function publicKeys() {
  return listKeys().map((k) => ({
    id: k.id,
    label: k.label,
    provider: (k.provider ?? "gemini") as ProviderId,
    model: modelFor(k),
    // The pool's "key" is this app's token for it, and showing its last four
    // characters would read as a key fragment. It is not one, and there is
    // nothing about it worth recognising at a glance.
    hint: isBrokerKey(k.id) ? "" : `…${k.key.slice(-4)}`,
    status: statusOf(k),
    availableAt: past(k.exhaustedUntil)
      ? past(k.cooldownUntil)
        ? null
        : k.cooldownUntil
      : k.exhaustedUntil,
    lastError: k.lastError ?? null,
    calls: k.calls ?? 0,
    tokens: (k.tokensIn ?? 0) + (k.tokensOut ?? 0),
    fromEnv: k.id === "env",
    /** The shared pool rather than a key of yours: nothing here to remove, and
     *  its state is a fact about the network that a restart re-learns. */
    shared: isBrokerKey(k.id),
  }));
}
