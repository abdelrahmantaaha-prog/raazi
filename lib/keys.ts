import crypto from "node:crypto";
import { readStore, writeStore } from "./config-file";
import { modelsFor, spec, type ProviderId } from "./providers";

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
  return keys.map((k) => ({ ...k, provider: k.provider ?? "gemini" }));
}

function persist(keys: ApiKey[]) {
  const stored = read();
  // The environment key is not ours to save.
  write({ ...stored, keys: keys.filter((k) => k.id !== "env"), apiKey: undefined });
}

function update(id: string, patch: Partial<ApiKey>) {
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
declare global {
  // eslint-disable-next-line no-var
  var __corpusKeyLastUsed: Map<string, number> | undefined;
}

/** Noted on every call, so the next one can go to a different key. */
export function noteCall(keyId: string): void {
  (globalThis.__corpusKeyLastUsed ??= new Map()).set(keyId, Date.now());
}

export function lastCallAt(keyId: string): number {
  return globalThis.__corpusKeyLastUsed?.get(keyId) ?? 0;
}

/**
 * Which key answers this call: the one that has rested longest.
 *
 * It used to be `free[0]`, and that one line was the whole throughput of the
 * application. The pacer waits a per-key interval between calls — six seconds
 * at the default ten a minute — and every call asked for the same first key,
 * so thirty-five keys ran at the speed of one. The morning's backlog was not
 * Gemini being slow; it was Corpus queueing behind itself.
 *
 * Least-recently-used rather than round-robin because it needs no cursor to
 * keep, survives a key going out of quota and coming back, and lands on a
 * never-used key first — the map starts empty, so a fresh ring fans out
 * immediately.
 */
export function nextKey(
  provider?: ProviderId,
  exclude: Set<string> = new Set(),
  prefer?: string
): ApiKey | undefined {
  const free = usableKeys(provider).filter((k) => !exclude.has(k.id));
  if (prefer) {
    const pinned = free.find((k) => k.id === prefer);
    if (pinned) return pinned;
  }
  if (free.length <= 1) return free[0];

  let best = free[0];
  let bestAt = lastCallAt(best.id);
  for (const k of free) {
    const at = lastCallAt(k.id);
    if (at < bestAt) {
      best = k;
      bestAt = at;
    }
  }
  return best;
}

export function hasUsableKey(provider?: ProviderId): boolean {
  return usableKeys(provider).length > 0;
}

/** Which providers you have at least one key for. */
export function configuredProviders(): ProviderId[] {
  return [...new Set(listKeys().map((k) => k.provider ?? "gemini"))];
}

/**
 * Which model this key asks for.
 *
 * Three answers in order, and the middle one was missing. A key may name its
 * own model, and that still wins. Otherwise, for Gemini, the model named in
 * Settings — which until now was read when validating a key and when counting
 * tokens, and ignored by every call that actually did work. The field looked
 * like the model setting, was documented as the model setting, and could not
 * change the model. Last, the provider's own default.
 *
 * Read through config-file rather than lib/config, which imports this module:
 * the same reason lib/lan.ts reads it directly.
 */
export function modelFor(key: ApiKey): string {
  const provider = key.provider ?? "gemini";
  const named = key.model?.trim();
  if (named) return named;

  // The ring, minus whatever is out of quota today. A model pinned in Settings
  // goes to the front of it rather than replacing it, so choosing a model is
  // still a preference and not a way to strand the app on a spent one.
  const configured = provider === "gemini" ? readStore<{ model?: string }>().model?.trim() : undefined;
  const ring = configured
    ? [configured, ...modelsFor(provider).filter((m) => m !== configured)]
    : modelsFor(provider);

  const live = ring.filter((m) => !modelSpent(provider, m));
  return live[0] ?? ring[0] ?? spec(provider).defaultModel;
}

declare global {
  // eslint-disable-next-line no-var
  var __corpusSpentModels: Map<string, number> | undefined;
}

/**
 * Models that answered "out of quota", and when to believe in them again.
 *
 * Held in memory rather than on disk: a daily allowance is a fact about today
 * that a restart is entitled to re-test, and the cost of re-testing is one
 * call. Keyed by provider and model, never by key — this is the whole point,
 * since the quota belongs to the model and is shared by every key you own.
 */
function spentModels(): Map<string, number> {
  return (globalThis.__corpusSpentModels ??= new Map());
}

export function markModelSpent(provider: ProviderId, model: string, minutes = 60): void {
  spentModels().set(`${provider}:${model}`, Date.now() + minutes * 60_000);
  console.log(`[corpus] ${model} is out of quota; the ring moves on for ${minutes} minutes`);
}

/** How long a model that answered "high demand" is left alone. Google's
 *  spikes are short; a busy model is asked again well within the hour. */
export const BUSY_MINUTES = 10;

/**
 * A model that is up but will not serve — a 503 "high demand" — set aside
 * for a few minutes so the same key asks the next model down.
 *
 * The same map as a spent model, and for the same reason: the condition is
 * the model's, not the key's. On 15 September 2026 the head of the ring
 * answered 503 to every key for an afternoon while the three models below it
 * were serving in under a second, and the rotation — which read a 503 as "this
 * provider is down" and stepped straight to the local model — never asked
 * them. The whole queue stood behind a model that was busy.
 */
export function markModelBusy(provider: ProviderId, model: string, minutes = BUSY_MINUTES): void {
  spentModels().set(`${provider}:${model}`, Date.now() + minutes * 60_000);
  console.log(`[corpus] ${model} is busy; the ring moves on for ${minutes} minutes`);
}

export function modelSpent(provider: ProviderId, model: string): boolean {
  const until = spentModels().get(`${provider}:${model}`);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  spentModels().delete(`${provider}:${model}`);
  return false;
}

/** For tests, and for a settings page that has just been given a new key. */
export function clearSpentModels(): void {
  spentModels().clear();
}

/** Whether any model of this provider is still worth asking. */
export function hasLiveModel(provider: ProviderId): boolean {
  return modelsFor(provider).some((m) => !modelSpent(provider, m));
}

/**
 * When every key is spent, this is when the first one comes back — the run
 * should sleep until then, not until the last one resets.
 */
export function earliestReset(provider?: ProviderId): Date | undefined {
  // Each key is waiting on whichever of its two clocks is still in the
  // future. Taking exhaustedUntil ?? cooldownUntil used to let a stale,
  // already-past exhaustion hide a live cooldown on the same key — the key
  // then counted as "not waiting", the ring reported no reset at all, and
  // the run was parked for an hour over a twenty-second window.
  const waiting = liveKeys(provider).flatMap((k) =>
    [k.exhaustedUntil, k.cooldownUntil]
      .filter((t): t is string => Boolean(t) && !past(t))
      .map((t) => new Date(t).getTime())
  );
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
    // Both clocks, not just the short one: a key that answered is not out of
    // quota, whatever a stale exhaustedUntil says, and leaving that behind is
    // what let it mask a later cooldown in earliestReset.
    lastError: null,
    cooldownUntil: null,
    exhaustedUntil: null,
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
    hint: `…${k.key.slice(-4)}`,
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
  }));
}
