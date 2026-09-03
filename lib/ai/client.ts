import { GoogleGenAI } from "@google/genai";
import type { Schema } from "@google/genai";
import { getConfig } from "../config";
import {
  earliestReset,
  listKeys,
  liveKeys,
  markCooldown,
  markExhausted,
  markInvalid,
  markUsed,
  modelFor,
  nextKey,
  type ApiKey,
} from "../keys";
import { localKeys } from "../keys";
import { brokerIsDown, brokerRetryAt, isBrokerKey } from "../broker";
import { spec, type ProviderId, type Stage } from "../providers";
import { chatJson, chatText, validateOpenAiKey } from "./openai";
import {
  AllKeysExhaustedError,
  MissingKeyError,
  NoUsableKeysError,
  SafetyBlockError,
  TruncatedOutputError,
  keyFailure,
} from "./errors";

export interface Usage {
  tokensIn: number;
  tokensOut: number;
}

export interface CallResult<T> {
  data: T;
  usage: Usage;
  /** The model that actually answered, when the provider said. The pool may
   *  hand a request for the strong model to a smaller one and says so in a
   *  header; a local Gemini key reports the version behind the alias. */
  model?: string;
}

type Part =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { fileUri: string; mimeType?: string } };

/** What a call needs from whoever answers it. */
type Need = "vision" | "audio" | "embed" | undefined;

/**
 * Picks who answers this call.
 *
 * The rules, in order:
 *  1. A call needing OCR, transcription or embeddings goes to a provider that
 *     can actually do it. Almost nothing free can, which is why Gemini stays
 *     the backbone rather than being replaced.
 *  2. Non-Latin text goes to the provider set for it. The alternatives are
 *     appreciably weaker on Arabic, and a missed name is a silent loss — worse
 *     than a slow one.
 *  3. Otherwise, whatever this stage is routed to.
 *
 * The result is a list, not one provider: if the first has no usable keys the
 * call falls through to the next rather than parking the run.
 */
export function providersFor(
  stage: Stage | undefined,
  opts: { need?: Need; lang?: string; sample?: string } = {}
): ProviderId[] {
  const cfg = getConfig();
  const fallback: ProviderId = "gemini";
  const capable = (p: ProviderId) => !opts.need || spec(p).capabilities[opts.need];
  const candidates: ProviderId[] = [];

  if (opts.need) {
    // Capability first: a stage preference is irrelevant if it cannot do the job.
    const routed = stage ? cfg.routing?.[stage] : undefined;
    for (const p of [routed, fallback, ...Object.values(cfg.routing ?? {})]) {
      if (p && capable(p) && !candidates.includes(p)) candidates.push(p);
    }
  } else {
    const preferred = isNonLatin(opts.lang, opts.sample)
      ? cfg.nonLatinProvider ?? fallback
      : (stage && cfg.routing?.[stage]) || fallback;
    candidates.push(preferred);
  }

  // Gemini is the last resort for everything, because it can do everything.
  if (!candidates.includes(fallback) && capable(fallback)) candidates.push(fallback);
  return candidates.length ? candidates : [fallback];
}

const NON_LATIN_SCRIPT = /[؀-ۿ֐-׿Ѐ-ӿ一-鿿぀-ヿ가-힯ऀ-ॿͰ-Ͽ฀-๿]/g;

/**
 * A source's declared language is only set for EPUB and web articles — a PDF
 * or a pasted passage has none. So when there is no declaration, read the text.
 * A fifth of the characters being non-Latin is well clear of the odd loanword
 * or quoted phrase in an otherwise English document.
 */
export function isNonLatin(lang?: string, sample?: string): boolean {
  if (lang && /^(ar|fa|ur|he|ru|zh|ja|ko|hi|el|th)\b/i.test(lang)) return true;
  if (lang && /^(en|fr|de|es|it|pt|nl|sv|tr|id|pl)\b/i.test(lang)) return false;

  const text = sample ?? lang;
  if (!text) return false;
  const hits = (text.match(NON_LATIN_SCRIPT) ?? []).length;
  return hits > text.length * 0.2;
}

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

/**
 * No call runs forever. A stalled socket used to freeze the single worker
 * until someone restarted the server — the loop was simply awaiting a fetch
 * that would never return. Three minutes covers any text call with room to
 * spare; a recording or a scanned page is a different animal, and gets ten.
 */
export const CALL_TIMEOUT_MS = 180_000;
export const MEDIA_TIMEOUT_MS = 600_000;

function timeoutFor(need: Need, explicit?: number): number {
  if (explicit && explicit > 0) return explicit;
  return need === "audio" || need === "vision" ? MEDIA_TIMEOUT_MS : CALL_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Which model answered
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __corpusModelsUsed: string[] | undefined;
}

/**
 * Handlers do not pass the model back through finishTask — they never had a
 * reason to, and there are fifteen of them. So the client notes every model
 * that answers here, and the worker, which runs one task at a time, collects
 * the notes when the task lands. A global rather than a module variable so a
 * hot reload does not leave two lists.
 */
function noteModel(model: string | undefined) {
  if (!model) return;
  (globalThis.__corpusModelsUsed ??= []).push(model);
}

/** The models that have answered since the last take, deduplicated. */
export function takeModelsUsed(): string[] {
  const used = globalThis.__corpusModelsUsed ?? [];
  globalThis.__corpusModelsUsed = [];
  return [...new Set(used)];
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

/**
 * A paced gate in front of every call. Free tiers cap requests per minute, and
 * waiting here is cheaper than eating a 429 and unwinding a task. The limit is
 * per key, so the gate is too: three keys buy three times the throughput.
 */
declare global {
  // eslint-disable-next-line no-var
  var __corpusLastCall: Map<string, number> | undefined;
}

/**
 * How many of a single key's lanes the shared pool is treated as being worth.
 *
 * The pool is one key id here and a ring of keys behind it, so pacing it like a
 * single key would throttle the whole ring to one key's rate — the exact thing
 * the pool exists to avoid. That was the argument for not pacing it at all, and
 * it was the wrong conclusion: unpaced, a queue that fans one entity out into
 * four tasks emptied itself at whatever rate the loop could manage, which was a
 * thousand calls in an hour. Nothing downstream was in a position to say no
 * politely — the broker rotates keys, it never sleeps — so the pool absorbed
 * the burst as refusals, and refusals cost writes.
 *
 * Six is deliberately not thirty-seven. This is a guard against a runaway loop,
 * not a throughput budget: at the default ten a minute it allows sixty calls a
 * minute, comfortably above anything the pipeline produces when it is behaving
 * and comfortably below the rate at which it stops behaving.
 */
const BROKER_LANES = 6;

const DEFAULT_RPM = 10;

/**
 * The configured rate, read defensively. Zero means "no pacing" and has to be
 * said outright; a setting that is not a number at all — a blank field saved
 * from Settings, a negative typed by mistake — is the default, not an open
 * gate. A NaN here used to make the gap NaN, the wait NaN, and the pacer a
 * no-op for every key on the ring.
 */
function requestsPerMinute(): number {
  const raw: unknown = getConfig().requestsPerMinute;
  if (raw === 0) return 0;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return DEFAULT_RPM;
  return raw;
}

async function pace(keyId: string) {
  const rpm = requestsPerMinute();
  if (rpm === 0) return;
  if (!globalThis.__corpusLastCall) globalThis.__corpusLastCall = new Map();

  const minGap = 60_000 / (isBrokerKey(keyId) ? rpm * BROKER_LANES : rpm);
  const last = globalThis.__corpusLastCall.get(keyId) ?? 0;
  const wait = last + minGap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  globalThis.__corpusLastCall.set(keyId, Date.now());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * How many keys one call may see rejected before it stops and blames itself.
 *
 * A key the provider rejects is set aside for good, and rightly — but two in a
 * row on a single call is not two bad keys, it is one bad request: a file URI
 * that belongs to somebody else, a model name that needs a permission this
 * project lacks. Walking the whole ring on that would mark every key invalid,
 * permanently, and only a hand revival brings them back.
 */
const MAX_INVALID_PER_CALL = 2;

/** How long the pool is set aside when it cannot say when it will be back. */
const BROKER_FLAT_WAIT_MS = 60_000;
/** And the ceiling on what it may ask for — beyond this the local keys go. */
const BROKER_MAX_WAIT_MS = 30 * 60_000;

/**
 * Runs a call against the candidate providers, rotating keys within each.
 *
 * A key that hits its daily quota is set aside until it resets and the work
 * continues immediately on the next key — then, if that provider is exhausted
 * entirely, on the next provider. Only when nothing can answer does this give
 * up, reporting when the *first* key anywhere comes back so the worker sleeps
 * no longer than it must.
 *
 * The error is read first, and it decides everything. Only a failure that is
 * about the key — quota, rate, rejection — moves the work to another key;
 * anything else (an output cut short, a safety block, an empty answer, a bad
 * request) is thrown at once, because no key on the ring will answer it
 * differently and every extra attempt is a full call's worth of tokens. The
 * pool used to sit in front of that check and swallow the lot as "the pool
 * refused"; an oversized passage cost three full calls before the worker
 * learned it should split it.
 */
async function withRotation<T>(
  candidates: ProviderId[],
  fn: (key: ApiKey) => Promise<T>
): Promise<{ value: T; key: ApiKey }> {
  const tried = new Set<string>();
  let lastError: unknown;
  let invalidInARow = 0;

  for (const provider of candidates) {
    for (;;) {
      const key = nextKey(provider, tried);
      if (!key) break; // this provider is spent; try the next one

      tried.add(key.id);
      await pace(key.id);

      try {
        const value = await fn(key);
        return { value, key };
      } catch (err) {
        lastError = err;
        const failure = keyFailure(err);

        if (isBrokerKey(key.id)) {
          // The broker being unreachable is not a refusal — it is the pool
          // being out of the picture for a while. Step past it and let this
          // machine's own keys take the work, which is what they were kept for.
          if (brokerIsDown(err)) {
            markCooldown(key.id, 5 * 60_000, "The shared key pool is unreachable.");
            console.warn("[corpus] the key pool is unreachable; falling back to local keys");
            continue;
          }

          // The pool is a service, not a key with a daily allowance. When it
          // refuses on quota it refuses for now: it rotates its own ring and
          // drops to a smaller model when one is spent, so its answer changes
          // minute to minute. It says when the first of its keys comes back
          // (broker_exhausted carries retryAt), and that is honoured — capped,
          // since the local keys are right there — over any flat guess.
          if (failure.kind === "rate" || failure.kind === "daily") {
            const retryAt = brokerRetryAt(err);
            const wait = retryAt
              ? Math.min(Math.max(retryAt.getTime() - Date.now(), 5_000), BROKER_MAX_WAIT_MS)
              : failure.kind === "rate"
                ? Math.min(failure.delayMs, BROKER_MAX_WAIT_MS)
                : BROKER_FLAT_WAIT_MS;
            markCooldown(key.id, wait, `The shared key pool: ${failure.reason}`);
            continue;
          }

          // A rejection through the pool is about the pool's keys or this
          // app's token, neither of which a local key shares. Set it aside
          // for a minute — never "invalid", which would need a hand revival
          // for what a restart of the broker fixes.
          if (failure.kind === "invalid") {
            markCooldown(key.id, BROKER_FLAT_WAIT_MS, `The shared key pool: ${failure.reason}`);
            continue;
          }

          // Anything else is the request's own problem. See above.
          throw err;
        }

        if (failure.kind === "daily") {
          invalidInARow = 0;
          markExhausted(key.id, failure.reason, getConfig().keyRetryMinutes);
          console.log(`[corpus] key "${key.label}" is out of quota for the day; trying the next one`);
          continue;
        }
        if (failure.kind === "invalid") {
          markInvalid(key.id, failure.reason);
          console.warn(`[corpus] key "${key.label}" was rejected; trying the next one`);
          if (++invalidInARow >= MAX_INVALID_PER_CALL) {
            console.warn(
              `[corpus] ${invalidInARow} keys rejected on one call — treating that as a bad request, not bad keys`
            );
            throw err;
          }
          continue;
        }
        if (failure.kind === "rate") {
          invalidInARow = 0;
          markCooldown(key.id, failure.delayMs, failure.reason);
          if (nextKey(provider, tried)) continue;
          break; // let the next provider take it
        }
        // Not the key's fault — the worker decides what to do with it.
        throw err;
      }
    }
  }

  // Nothing could answer. Work out whether that is a quota problem or yours.
  if (listKeys().length === 0) throw new MissingKeyError();

  const live = candidates.flatMap((p) => liveKeys(p));
  if (live.length === 0) {
    throw new NoUsableKeysError(
      `No usable key for ${candidates.map((p) => spec(p).label).join(" or ")}. Check Settings.`
    );
  }

  const resumeAt = candidates
    .map((p) => earliestReset(p))
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  if (resumeAt) throw new AllKeysExhaustedError(resumeAt, live.length);
  throw lastError ?? new Error("No provider could complete the request.");
}

/** How many times a pinned key is waited on before the call gives up, and
 *  the longest any one of those waits may be. Three short waits cover a busy
 *  minute; anything longer is a spent key, and the run should park. */
const PIN_RETRIES = 3;
const PIN_MAX_WAIT_MS = 90_000;

/**
 * Runs a call on one particular key and no other.
 *
 * The Files API hands back a URI that only the uploading key can read, so the
 * call that reads it cannot rotate: every other key would get a 403 for a
 * file it does not own. That 403 used to be read as "the provider rejected
 * this key", and one busy minute on the pinned key marked every local key
 * invalid, permanently. So a pinned key that is rate-limited is waited for —
 * here, in the call, bounded — and a pinned key that is spent or rejected
 * ends the call with that news rather than trying its neighbours.
 */
async function withPinnedKey<T>(
  pin: string,
  fn: (key: ApiKey) => Promise<T>
): Promise<{ value: T; key: ApiKey }> {
  const usableNow = (k: ApiKey) => !k.disabled && !k.invalid && past(k.exhaustedUntil) && past(k.cooldownUntil);
  const waitingOn = (k: ApiKey) =>
    Math.max(
      ...[k.exhaustedUntil, k.cooldownUntil]
        .filter((t): t is string => Boolean(t))
        .map((t) => new Date(t).getTime() - Date.now()),
      0
    );

  let waits = 0;
  for (;;) {
    const key = listKeys().find((k) => k.id === pin);
    if (!key) throw new Error(`The key that uploaded this file (${pin}) is no longer on the ring.`);
    if (key.invalid || key.disabled) {
      throw new NoUsableKeysError(
        `The key that uploaded this file ("${key.label}") is ${key.invalid ? "rejected" : "set aside"}, and no other key can read the file.`
      );
    }
    if (!usableNow(key)) {
      const wait = waitingOn(key);
      // Further out than a rate limit should ever be: the key is spent, and
      // the run should park until it comes back rather than hold the loop.
      if (wait > PIN_MAX_WAIT_MS || waits >= PIN_RETRIES) {
        throw new AllKeysExhaustedError(new Date(Date.now() + wait), 1);
      }
      waits++;
      console.log(`[corpus] waiting ${Math.ceil(wait / 1000)}s for pinned key "${key.label}"`);
      await sleep(wait);
      continue;
    }

    await pace(key.id);
    try {
      const value = await fn(key);
      return { value, key };
    } catch (err) {
      const failure = keyFailure(err);
      if (failure.kind === "rate") {
        // Marked so the wait above is the provider's own figure, then round
        // again on the same key. The cooldown escalates on repeats, which is
        // what turns a genuinely spent key into the park above.
        markCooldown(key.id, Math.min(failure.delayMs, PIN_MAX_WAIT_MS), failure.reason);
        continue;
      }
      if (failure.kind === "daily") markExhausted(key.id, failure.reason, getConfig().keyRetryMinutes);
      if (failure.kind === "invalid") markInvalid(key.id, failure.reason);
      throw err;
    }
  }
}

const past = (iso?: string | null) => !iso || new Date(iso).getTime() <= Date.now();

/**
 * Bills a call to its key. A failed write to config.json — the disk full, a
 * scanner holding the file — must not throw away an answer the model has
 * already given: the tokens are spent either way, and the answer is the
 * only thing that makes them worth it.
 */
function bill(keyId: string, usage: Usage) {
  try {
    markUsed(keyId, usage.tokensIn, usage.tokensOut);
  } catch (err) {
    console.warn(`[corpus] could not record usage for key ${keyId}: ${(err as Error)?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/**
 * The Gemini SDK, pointed wherever this key says.
 *
 * A key on the ring is a key; a key on the broker is a key plus a base URL, and
 * the SDK will happily talk to a proxy that speaks Google's own API — which is
 * exactly what the broker's /gemini surface is. Nothing else about the call
 * changes, which is why OCR, audio and response schemas all still work.
 */
function gemini(k: ApiKey, timeoutMs = CALL_TIMEOUT_MS): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: k.key,
    // `timeout` aborts the fetch, not just the read — the SDK wires it to an
    // AbortController — so a socket that never answers cannot hold the worker.
    httpOptions: { timeout: timeoutMs, ...(k.baseUrl ? { baseUrl: k.baseUrl } : {}) },
  });
}

/** Providers other than Gemini take one text prompt, so parts are flattened.
 *  Non-text parts never reach them — the router guarantees that. */
function partsToPrompt(parts: (string | Part)[]): string {
  return parts
    .map((p) => (typeof p === "string" ? p : "text" in p ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

function geminiParts(parts: (string | Part)[]) {
  return parts.map((p) => (typeof p === "string" ? { text: p } : p));
}

function usageOfGemini(res: {
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}): Usage {
  return {
    tokensIn: res.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: res.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

/** The model that answered a Gemini call: the pool's header when it went
 *  through the pool, else the version Google resolved the alias to. */
function modelOfGemini(res: {
  sdkHttpResponse?: { headers?: Record<string, string> };
  modelVersion?: string;
}): string | undefined {
  const h = res.sdkHttpResponse?.headers ?? {};
  return h["x-broker-model"] ?? h["X-Broker-Model"] ?? res.modelVersion ?? undefined;
}

function checkGeminiFinish(finish: unknown, blockReason?: unknown) {
  if (finish === "MAX_TOKENS") throw new TruncatedOutputError();
  if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || finish === "BLOCKLIST") {
    throw new SafetyBlockError(String(finish));
  }
  if (blockReason) throw new SafetyBlockError(String(blockReason));
}

/** One structured-output call, routed and paced. */
export async function generateJson<T>(opts: {
  parts: (string | Part)[];
  schema: Schema;
  system?: string;
  temperature?: number;
  model?: string;
  stage?: Stage;
  lang?: string;
  /** Text to sniff the script from when the source declares no language. */
  sample?: string;
  /** Ceiling on one attempt, in ms. Defaults to three minutes. */
  timeoutMs?: number;
}): Promise<CallResult<T>> {
  const candidates = providersFor(opts.stage, { lang: opts.lang, sample: opts.sample });
  const timeoutMs = timeoutFor(undefined, opts.timeoutMs);

  const { value, key } = await withRotation(candidates, async (k): Promise<CallResult<T>> => {
    const provider = k.provider ?? "gemini";

    if (spec(provider).kind === "openai") {
      return chatJson<T>({
        provider,
        apiKey: k.key,
        model: opts.model ?? modelFor(k),
        baseUrl: k.baseUrl,
        system: opts.system,
        prompt: partsToPrompt(opts.parts),
        schema: opts.schema,
        temperature: opts.temperature,
        timeoutMs,
      });
    }

    const ai = gemini(k, timeoutMs);
    const res = await ai.models.generateContent({
      model: opts.model ?? modelFor(k),
      contents: [{ role: "user", parts: geminiParts(opts.parts) }],
      config: {
        responseMimeType: "application/json",
        responseSchema: opts.schema,
        temperature: opts.temperature ?? 0.1,
        ...(opts.system ? { systemInstruction: opts.system } : {}),
      },
    });

    const usage = usageOfGemini(res);
    const model = modelOfGemini(res);
    checkGeminiFinish(res.candidates?.[0]?.finishReason, res.promptFeedback?.blockReason);
    if (!res.text) throw new Error("Empty response.");

    try {
      return { data: JSON.parse(res.text) as T, usage, model };
    } catch {
      throw new TruncatedOutputError();
    }
  });

  bill(key.id, value.usage);
  noteModel(value.model);
  return value;
}

/** Plain-text call. `need` forces a provider that can read images or audio. */
export async function generateText(opts: {
  parts: (string | Part)[];
  system?: string;
  temperature?: number;
  model?: string;
  stage?: Stage;
  lang?: string;
  sample?: string;
  need?: Need;
  /** Read with this key and no other — see uploadClient(). */
  pin?: string;
  /** Ceiling on one attempt, in ms. Defaults to three minutes, or ten for a
   *  call that needs to read images or audio. */
  timeoutMs?: number;
}): Promise<CallResult<string>> {
  const candidates = providersFor(opts.stage, {
    need: opts.need,
    lang: opts.lang,
    sample: opts.sample,
  });
  const timeoutMs = timeoutFor(opts.need, opts.timeoutMs);

  const call = async (k: ApiKey): Promise<CallResult<string>> => {
    const provider = k.provider ?? "gemini";

    if (spec(provider).kind === "openai") {
      return chatText({
        provider,
        apiKey: k.key,
        model: opts.model ?? modelFor(k),
        baseUrl: k.baseUrl,
        system: opts.system,
        prompt: partsToPrompt(opts.parts),
        temperature: opts.temperature,
        timeoutMs,
      });
    }

    const ai = gemini(k, timeoutMs);
    const res = await ai.models.generateContent({
      model: opts.model ?? modelFor(k),
      contents: [{ role: "user", parts: geminiParts(opts.parts) }],
      config: {
        temperature: opts.temperature ?? 0.2,
        ...(opts.system ? { systemInstruction: opts.system } : {}),
      },
    });

    const usage = usageOfGemini(res);
    const model = modelOfGemini(res);
    checkGeminiFinish(res.candidates?.[0]?.finishReason, res.promptFeedback?.blockReason);
    if (!res.text) throw new Error("Empty response.");
    return { data: res.text, usage, model };
  };

  const { value, key } = opts.pin
    ? await withPinnedKey(opts.pin, call)
    : await withRotation(candidates, call);

  bill(key.id, value.usage);
  noteModel(value.model);
  return value;
}

/** Embeddings, for entity-resolution candidates. */
export async function embed(texts: string[]): Promise<{ vectors: Float32Array[]; usage: Usage }> {
  const cfg = getConfig();
  const candidates = providersFor(undefined, { need: "embed" });

  const { value, key } = await withRotation(candidates, async (k) => {
    const ai = gemini(k);
    const res = await ai.models.embedContent({
      model: cfg.embedModel,
      contents: texts,
      config: { taskType: "SEMANTIC_SIMILARITY", outputDimensionality: 768 },
    });
    return {
      vectors: (res.embeddings ?? []).map((e) => new Float32Array(e.values ?? [])),
      // The embeddings endpoint reports no token counts, so the input is
      // estimated at the usual four characters a token. Better than the
      // zero that used to be billed — resolve was the one stage the per-key
      // figures in Settings knew nothing about.
      usage: { tokensIn: Math.ceil(texts.join("").length / 4), tokensOut: 0 },
    };
  });

  bill(key.id, value.usage);
  return value;
}

/**
 * The file-upload API the SDK owns, and the key it is speaking as.
 *
 * This one call cannot go through the pool. The Files API hands back a URI that
 * only the uploading key can read, and the broker picks a fresh key per
 * request — so an upload there and a read here would be two different keys and
 * the file would not exist. It stays on a key this machine owns, and the caller
 * is told which one so the call that reads the file can ask for it by name.
 */
export function uploadClient(): { ai: GoogleGenAI; keyId: string } {
  const key = localKeys("gemini")[0];
  if (!key) throw new MissingKeyError();
  return { ai: gemini(key, MEDIA_TIMEOUT_MS), keyId: key.id };
}

/** For calls that need a Gemini client but no particular key — counting tokens,
 *  say. The pool is fine for those, so it is tried first as usual. */
export function client(): GoogleGenAI {
  const key = nextKey("gemini");
  if (!key) throw new MissingKeyError();
  return gemini(key);
}

/** Pre-flight cost estimate, so a book can be priced before it is started. */
export async function countTokens(text: string): Promise<number> {
  const cfg = getConfig();
  const res = await client().models.countTokens({
    model: cfg.model,
    contents: [{ role: "user", parts: [{ text }] }],
  });
  return res.totalTokens ?? 0;
}

export async function validateKey(
  apiKey: string,
  provider: ProviderId = "gemini",
  model?: string,
  baseUrl?: string
): Promise<{ ok: boolean; error?: string }> {
  if (spec(provider).kind === "openai") {
    return validateOpenAiKey(provider, apiKey, model, baseUrl);
  }
  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 30_000 } });
    await ai.models.generateContent({
      model: model || getConfig().model,
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      config: { maxOutputTokens: 8 },
    });
    return { ok: true };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/api key not valid|unauthenticated|401|403/i.test(raw)) {
      return { ok: false, error: "That key was rejected by Google." };
    }
    if (/quota|429|resource_exhausted/i.test(raw)) {
      return { ok: true, error: "Key is valid but currently out of quota." };
    }
    return { ok: false, error: raw.slice(0, 200) };
  }
}
