import { AsyncLocalStorage } from "node:async_hooks";
import { GoogleGenAI } from "@google/genai";
import type { Schema } from "@google/genai";
import { getConfig } from "../config";
import {
  earliestReset,
  hasUsableKey,
  listKeys,
  liveKeys,
  markCooldown,
  markExhausted,
  markInvalid,
  markModelBusy,
  markModelSpent,
  markUsed,
  isLiteModel,
  modelFor,
  modelSpent,
  nextKey,
  noteCall,
  usableKeys,
  type ApiKey,
} from "../keys";
import { spec, type ProviderId, type Stage } from "../providers";
import { unescapeModelJson } from "./escapes";
import { withLessons } from "../lessons";
import { researchKeys, researchServerPath } from "../research/keys";
import { chatJson, chatText, validateOpenAiKey } from "./openai";
import { anthropicJson, anthropicText, validateAnthropicKey, EFFORT } from "./anthropic";
import { claudeCodeJson, claudeCodeText, validateClaudeCode, type Attachment } from "./claude-code";
import {
  AllKeysExhaustedError,
  SchemaUnsupportedError,
  isConnRefused,
  isProviderUnavailable,
  isTimeout,
  MissingKeyError,
  ModelExhaustedError,
  NoUsableKeysError,
  ProvidersBusyError,
  SafetyBlockError,
  TruncatedOutputError,
  keyFailure,
  noFreeTierQuota,
} from "./errors";

/** How long a local endpoint that refused a connection is set aside. It is not
 *  a quota or a rate limit — the service simply is not there — so this only has
 *  to be long enough that the ring stops dialing a dead port on every task. */
const LOCAL_DOWN_COOLDOWN_MS = 5 * 60_000;

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
 *  2. Otherwise, whatever this stage is routed to — whatever language the
 *     source is in.
 *  3. Then Gemini, then this machine's own model, as fallbacks.
 *
 * The result is a list, not one provider: if the first has no usable keys — or
 * is refusing, or is busy — the call falls through to the next rather than
 * parking the run.
 */
export function providersFor(
  stage: Stage | undefined,
  opts: { need?: Need } = {}
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
    candidates.push((stage && cfg.routing?.[stage]) || fallback);
  }

  // Gemini is the last resort for everything, because it can do everything.
  if (!candidates.includes(fallback) && capable(fallback)) candidates.push(fallback);

  // And behind Gemini, this machine — but only ever behind it.
  //
  // The free tier spends whole afternoons answering 503, and a run that parks
  // because Google is busy is a run that has stopped for a reason that has
  // nothing to do with you. The local model is slow and occasionally weak, so
  // it is a poor first choice for work Gemini will do in two seconds; it is an
  // excellent last one, because the alternative to slow is not fast, it is
  // nothing. Reached only when everything in front of it is spent, refusing or
  // down, and skipped for anything needing eyes, ears or embeddings.
  if (hasUsableKey("ollama") && capable("ollama") && !candidates.includes("ollama")) {
    candidates.push("ollama");
  }

  return candidates.length ? candidates : [fallback];
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

/**
 * Writing and checking an entry gets longer.
 *
 * Since the writer sees all of a subject's evidence at once — with its
 * timeline and relations — the prompt for a well-documented person is several
 * times what any other stage sends, and a busy provider can take minutes over
 * it. Three minutes was enough when the entry was written forty quotes at a
 * time; it is not now, and a timeout there throws away a call that was about
 * to succeed.
 */
const LONG_TIMEOUT_MS = 420_000;
const LONG_STAGES = new Set(["entry", "brief"]);

/**
 * The stages whose output is kept and read, as opposed to the stages that
 * read: an entry stands until its evidence changes, a brief is the morning's
 * record. Neither may be written by the lite tail of the model ring or by
 * the local model; when nothing better is free, the task waits.
 */
const QUALITY_STAGES = new Set<Stage>(["entry", "brief"]);

/** The stages whose work is small and forgiving, asked of the cheapest model first. */
const CHEAP_STAGES = new Set<Stage>(["group"]);
export const MEDIA_TIMEOUT_MS = 600_000;

function timeoutFor(need: Need, explicit?: number, stage?: Stage): number {
  if (explicit && explicit > 0) return explicit;
  if (need === "audio" || need === "vision") return MEDIA_TIMEOUT_MS;
  return stage && LONG_STAGES.has(stage) ? LONG_TIMEOUT_MS : CALL_TIMEOUT_MS;
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
  // A task's own list when the worker gave it one: with several passages
  // read at once, one shared list would hand each the others' models.
  const own = modelsOfTask.getStore();
  if (own) own.push(model);
  else (globalThis.__corpusModelsUsed ??= []).push(model);
}

/** The models that have answered since the last take, deduplicated. */
export function takeModelsUsed(): string[] {
  const used = globalThis.__corpusModelsUsed ?? [];
  globalThis.__corpusModelsUsed = [];
  return [...new Set(used)];
}

/** Runs one task's work with a list of its own for the models that answer it. */
export async function withOwnModels<T>(fn: () => Promise<T>): Promise<{ value: T; models: string[] }> {
  const own: string[] = [];
  try {
    const value = await modelsOfTask.run(own, fn);
    return { value, models: [...new Set(own)] };
  } catch (err) {
    (err as { modelsUsed?: string[] }).modelsUsed = [...new Set(own)];
    throw err;
  }
}

const modelsOfTask = new AsyncLocalStorage<string[]>();

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

  const minGap = 60_000 / rpm;
  const last = globalThis.__corpusLastCall.get(keyId) ?? 0;
  const wait = last + minGap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  globalThis.__corpusLastCall.set(keyId, Date.now());
  // The ring needs to know too, so the next call reaches for a rested key
  // rather than this one. See nextKey().
  noteCall(keyId);
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

/**
 * Which model this call asks THIS key for.
 *
 * One place, decided before the call and handed to it, because the rotation
 * has to know what it is about to spend: when the answer comes back "out of
 * quota for the day", the model that was actually asked is the one to set
 * aside. Working it out inside each provider branch, as the call used to,
 * left the rotation retiring modelFor(key) — whatever the ring would have
 * chosen — which for a call that asked for something else by name retired
 * every model in the ring without one of them being called.
 *
 * A key that names its own model is an outright pin. Otherwise, on Gemini, a
 * caller's model is a PREFERENCE rather than a pin: when its own allowance
 * is gone the ring answers instead, which beats reporting everything spent.
 * The other providers do not meter per model, so there the caller's model
 * simply stands.
 */
export function modelOfCall(k: ApiKey, opts: { model?: string; stage?: string }, quality = false, cheap = false): string {
  const provider = k.provider ?? "gemini";
  // Claude on the plan: the key's own model, else the one chosen in Settings.
  // A caller's model is a Gemini name and means nothing to Claude Code.
  // A stage can have its own Claude (Settings → routing).
  if (spec(provider).kind === "claude-code") {
    const cfg = getConfig();
    return k.model?.trim() || (opts.stage && cfg.stageModels?.[opts.stage as Stage]) || cfg.claudeModel || modelFor(k);
  }
  if (spec(provider).kind !== "gemini") return k.model?.trim() || opts.model || modelFor(k, { quality, cheap });
  const wanted = opts.model && !(quality && isLiteModel(opts.model)) ? opts.model : undefined;
  return wanted && !modelSpent(provider, wanted) ? wanted : modelFor(k, { quality, cheap });
}

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
 *
 * Exported for scripts/test-rotation.mjs, which drives it with a stand-in
 * for the provider call; nothing outside this module should call it.
 */
export async function withRotation<T>(
  candidates: ProviderId[],
  fn: (key: ApiKey, model: string) => Promise<T>,
  opts: {
    /** Which model to ask a given key for. Defaults to the ring's choice. */
    modelOf?: (key: ApiKey) => string;
    /**
     * This call can only be served by the one model `modelOf` names —
     * embeddings, where no text model is a substitute.
     *
     * It changes what a quota refusal means. On the free tier the allowance
     * belongs to the MODEL and every key draws on the same one, so the next
     * key meets the same wall: rotating through the ring achieves nothing and
     * sets aside every key on it for an hour on the way. So a pinned model
     * that refuses stops there, with the ring untouched.
     */
    hardPin?: boolean;
    /**
     * This call writes something that is kept — an entry, a brief — and must
     * not be served by a lite model or by the local one. `modelOf` already
     * refuses the lite tail of the ring; this makes the loop wait for a real
     * model when every one of them is spent or busy, instead of taking the
     * first thing that answers.
     */
    quality?: boolean;
  } = {}
): Promise<{ value: T; key: ApiKey }> {
  const pick = opts.modelOf ?? ((k: ApiKey) => modelFor(k, { quality: opts.quality }));
  const tried = new Set<string>();
  let lastError: unknown;
  let invalidInARow = 0;
  // Set when a provider answered "unavailable" (a busy 503) or could not be
  // reached at all (a refused connection). It changes what "nothing answered"
  // means at the end: the services are out, not the keys, so the task waits
  // rather than failing or — the bug this fixes — spinning.
  let sawUnavailable = false;

  for (const provider of candidates) {
    for (;;) {
      const key = nextKey(provider, tried);
      if (!key) break; // this provider is spent; try the next one

      tried.add(key.id);
      const model = pick(key);

      // Every model a quality call may use is set aside: wait for one to
      // come back rather than ask a spent one and burn the key on the
      // refusal, and rather than step down to what is left.
      if (opts.quality && modelSpent(provider, model)) {
        sawUnavailable = true;
        break;
      }
      await pace(key.id);

      try {
        const value = await fn(key, model);
        return { value, key };
      } catch (err) {
        lastError = err;

        // This provider's model cannot produce the shape. Every key here
        // reaches the same model, so the whole provider is skipped rather
        // than each of its keys refused in turn.
        if (err instanceof SchemaUnsupportedError) {
          console.warn(
            `[corpus] ${spec(provider).label} could not produce the JSON shape; trying the next provider`
          );
          break;
        }

        // Up but busy — a 503 "high demand". On Gemini that is a fact about
        // ONE MODEL: every key meets it, and the models below it in the ring
        // are usually serving in under a second. So the model is set aside
        // for a few minutes and the same key asks the next one down, exactly
        // as it does for a spent allowance. Stepping to the next provider
        // here, as this used to, left three healthy models unasked for an
        // afternoon and sent the whole queue to the local model.
        if (isProviderUnavailable(err) && !isConnRefused(err) && spec(provider).kind === "gemini") {
          markModelBusy(provider, model);
          const next = pick(key);
          if (next !== model && !modelSpent(provider, next)) {
            tried.delete(key.id);
            continue;
          }
        }

        // The local model taking longer than the call allows is the same
        // news as the local model not being there: it cannot serve this call
        // now. It is not a network blip to be charged against the task's
        // attempts — five of those failed the task for good, over a provider
        // that was only ever the last resort.
        const localTimeout = provider === "ollama" && isTimeout(err);

        // Busy with nothing left to ask, or not there at all (a refused
        // connection). Either way this provider cannot serve the call right
        // now, and — this is the point — every key on it meets the same wall,
        // so there is nothing to gain by trying its other keys. Step to the
        // next provider; if there is none, fall through to the tail, which now
        // parks the task instead of letting it spin.
        if (isProviderUnavailable(err) || isConnRefused(err) || localTimeout) {
          sawUnavailable = true;
          // A refused connection means the endpoint is not listening — the
          // local model with nothing behind it. Take its key off the ring for
          // a while so the next task does not dial the dead port again. A busy
          // 503 is left alone: the key is fine and the model is shared.
          if (isConnRefused(err)) {
            markCooldown(key.id, LOCAL_DOWN_COOLDOWN_MS, "The endpoint did not answer.");
          } else if (localTimeout) {
            markCooldown(key.id, LOCAL_DOWN_COOLDOWN_MS, "Took too long to answer.");
          }
          const next = candidates.indexOf(provider) + 1;
          if (next < candidates.length) {
            console.warn(`[corpus] ${spec(provider).label} is unavailable; trying ${spec(candidates[next]).label}`);
          }
          break;
        }

        const failure = keyFailure(err);

        if (failure.kind === "daily") {
          invalidInARow = 0;
          // Whose quota was it? On Gemini's free tier the allowance is counted
          // per model, and every key you own draws on the same one — so a
          // refusal here says the MODEL is spent, not the key, and setting the
          // key aside would burn thirty-five of them against the same wall.
          // Retire the model that ANSWERED, keep the key, and let it ask for
          // the next one down.
          //
          // It used to retire modelFor(key) — whatever the ring would have
          // chosen — no matter what this call had actually asked for, and
          // only when that model was in the ring. A refusal on a model the
          // ring did not list (the embedding model, say) was charged to the
          // key instead, and the next key met the same wall.
          // The Claude plan says when it resets, and that beats a guess.
          const minutes = failure.resetAt
            ? Math.max(1, Math.ceil((failure.resetAt.getTime() - Date.now()) / 60_000))
            : getConfig().keyRetryMinutes;
          markModelSpent(provider, model, minutes);

          // A model nothing can stand in for: the ring has no answer, and
          // asking the rest of the keys would only set them aside for a wall
          // they all share. Say which model it was and leave the ring alone.
          if (opts.hardPin) {
            throw new ModelExhaustedError(
              model,
              new Date(Date.now() + minutes * 60_000),
              failure.reason,
              noFreeTierQuota(err)
            );
          }

          // Anything left for this key to be asked? `pick` is asked again
          // rather than reasoned about, because it owns the fallback order —
          // and its answer is only useful if it is not itself spent, which is
          // also what stops this looping once everything is.
          const next = pick(key);
          if (next !== model && !modelSpent(provider, next)) {
            tried.delete(key.id);
            continue;
          }
          // A quality call with nothing real left to ask waits; the key is
          // fine and is not set aside for a wall that belongs to the model.
          if (opts.quality) {
            sawUnavailable = true;
            break;
          }
          markExhausted(key.id, failure.reason, minutes);
          console.log(`[corpus] key "${key.label}" has nothing left to ask; trying the next one`);
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

  // A provider was up-but-busy or unreachable this time. The keys are fine, so
  // this is neither a quota park nor a config error: the task waits a couple of
  // minutes and comes back. Checked before the quota reset below on purpose —
  // a local key just set aside for being down must not be read as "out of
  // quota until five minutes from now" and park the run under a false reason.
  if (sawUnavailable) {
    throw new ProvidersBusyError(
      `Every service is unavailable right now (${candidates.map((p) => spec(p).label).join(", ")}); waiting before trying again.`
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
  fn: (key: ApiKey, model: string) => Promise<T>,
  modelOf: (key: ApiKey) => string = modelFor
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
    const model = modelOf(key);
    try {
      const value = await fn(key, model);
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
      if (failure.kind === "daily") {
        // The same attribution as the rotation: the model that answered is
        // spent, and the pinned key may still have a next one to ask.
        const minutes = getConfig().keyRetryMinutes;
        markModelSpent(key.provider ?? "gemini", model, minutes);
        const next = modelOf(key);
        if (next !== model && !modelSpent(key.provider ?? "gemini", next)) continue;
        markExhausted(key.id, failure.reason, minutes);
      }
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
 * A key may carry a base URL, and the SDK will happily talk to any proxy that
 * speaks Google's own API. Nothing else about the call changes, which is why
 * OCR, audio and response schemas all still work through one.
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

/** The model that answered a Gemini call: the version Google resolved the
 *  alias to, when it said. */
function modelOfGemini(res: { modelVersion?: string }): string | undefined {
  return res.modelVersion ?? undefined;
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
  /** Answer with this provider, whatever the routing says. For measuring one
   *  against another; the pipeline itself always goes through the routing. */
  provider?: ProviderId;
  /** Ceiling on one attempt, in ms. Defaults to three minutes. */
  timeoutMs?: number;
}): Promise<CallResult<T>> {
  const quality = Boolean(opts.stage && QUALITY_STAGES.has(opts.stage));
  const cheap = Boolean(opts.stage && CHEAP_STAGES.has(opts.stage));
  // The stage's lessons ride on every call, in the researcher's words.
  const system = withLessons(opts.system, opts.stage);
  // What a quality call writes is kept for months; the local model is a last
  // resort for reading, never for that.
  const candidates = (opts.provider ? [opts.provider] : providersFor(opts.stage)).filter(
    (p) => !quality || p !== "ollama" || opts.provider === "ollama"
  );
  const timeoutMs = timeoutFor(undefined, opts.timeoutMs, opts.stage);

  const { value, key } = await withRotation(candidates, async (k, model): Promise<CallResult<T>> => {
    const provider = k.provider ?? "gemini";

    if (spec(provider).kind === "openai") {
      return chatJson<T>({
        provider,
        apiKey: k.key,
        model,
        baseUrl: k.baseUrl,
        system,
        prompt: partsToPrompt(opts.parts),
        schema: opts.schema,
        temperature: opts.temperature,
        timeoutMs,
      });
    }

    if (spec(provider).kind === "anthropic") {
      // No `temperature`: Claude rejects every sampling parameter outright, and
      // the callers all pass one. Effort is what replaced it, and it is chosen
      // per stage rather than per call — see EFFORT.
      return anthropicJson<T>({
        apiKey: k.key,
        model,
        baseUrl: k.baseUrl,
        system,
        prompt: partsToPrompt(opts.parts),
        schema: opts.schema,
        effort: EFFORT[opts.stage ?? ""],
        timeoutMs,
      });
    }

    if (spec(provider).kind === "claude-code") {
      // The same model and the same effort per stage as the API path, paid
      // for by the plan instead — see lib/ai/claude-code.ts.
      return claudeCodeJson<T>({
        apiKey: "",
        model,
        system,
        prompt: partsToPrompt(opts.parts),
        schema: opts.schema,
        effort: EFFORT[opts.stage ?? ""],
        // Claude Code takes most of a minute to start writing a long answer
        // and two more to write it: a dense passage measured 129 s on 3 Oct
        // 2026, against a three-minute ceiling meant for Gemini. A caller
        // that set its own limit (a search you are waiting on) keeps it.
        timeoutMs: opts.timeoutMs ?? Math.max(timeoutMs, CLAUDE_CODE_TIMEOUT_MS),
        // Reading writes the longest answers of all; see plainJson.
        plainJson: opts.stage === "extract",
      });
    }

    const ai = gemini(k, timeoutMs);
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: geminiParts(opts.parts) }],
      config: {
        responseMimeType: "application/json",
        responseSchema: opts.schema,
        temperature: opts.temperature ?? 0.1,
        ...(system ? { systemInstruction: system } : {}),
      },
    });

    const usage = usageOfGemini(res);
    const answered = modelOfGemini(res) ?? model;
    checkGeminiFinish(res.candidates?.[0]?.finishReason, res.promptFeedback?.blockReason);
    if (!res.text) throw new Error("Empty response.");

    try {
      return { data: unescapeModelJson(JSON.parse(res.text) as T), usage, model: answered };
    } catch {
      throw new TruncatedOutputError();
    }
  }, { modelOf: (k) => modelOfCall(k, opts, quality, cheap), quality });

  bill(key.id, value.usage);
  noteModel(value.model);
  return value;
}

/** A web check searches and reads pages in turn; a dozen claims take minutes. */
export const WEB_TIMEOUT_MS = 900_000;

/** Whether anything here can search the web: only Claude on your plan can. */
export function canSearchWeb(): boolean {
  return listKeys().some((k) => k.provider === "claude-code");
}

/**
 * A structured call that may search the web and read what it finds.
 *
 * Only Claude on your plan can, through Claude Code's own search and fetch —
 * there is no fallback, because a checker that quietly answered from memory
 * instead would hand back exactly the verdicts this exists to replace. The
 * answer comes with `seen`: every address the searches returned or a fetch
 * opened, so the caller can keep only the sources that were really read.
 */
export async function generateWebJson<T>(opts: {
  prompt: string;
  schema: Schema;
  system?: string;
  stage?: Stage;
  timeoutMs?: number;
  /** Also offer Corpus's research tools — registers, archives, public accounts, ships. */
  research?: boolean;
}): Promise<CallResult<T> & { seen: string[] }> {
  if (!canSearchWeb()) {
    throw new Error("Checking on the web needs Claude (your plan). Add it in Settings, then try again.");
  }
  const { value, key } = await withRotation(
    ["claude-code"],
    (k, model) =>
      claudeCodeJson<T>({
        apiKey: "",
        model,
        system: opts.system,
        prompt: opts.prompt,
        schema: opts.schema,
        effort: EFFORT[opts.stage ?? ""],
        timeoutMs: opts.timeoutMs ?? WEB_TIMEOUT_MS,
        web: true,
        research: opts.research
          ? { server: researchServerPath(), keys: researchKeys() as Record<string, string> }
          : undefined,
      }),
    { modelOf: (k) => modelOfCall(k, opts) }
  );
  bill(key.id, value.usage);
  noteModel(value.model);
  return { ...value, seen: value.seen ?? [] };
}

/** The least time a structured answer from Claude Code is given. */
const CLAUDE_CODE_TIMEOUT_MS = 360_000;

/** What Claude Code can open as a page or a picture, by type. */
const ATTACHABLE: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** Plain-text call. `need` forces a provider that can read images or audio. */
export async function generateText(opts: {
  parts: (string | Part)[];
  system?: string;
  temperature?: number;
  model?: string;
  stage?: Stage;
  need?: Need;
  /** Read with this key and no other — see uploadClient(). */
  pin?: string;
  /** Ceiling on one attempt, in ms. Defaults to three minutes, or ten for a
   *  call that needs to read images or audio. */
  timeoutMs?: number;
}): Promise<CallResult<string>> {
  const candidates = providersFor(opts.stage, { need: opts.need });
  const timeoutMs = timeoutFor(opts.need, opts.timeoutMs, opts.stage);

  const call = async (k: ApiKey, model: string): Promise<CallResult<string>> => {
    const provider = k.provider ?? "gemini";

    if (spec(provider).kind === "openai") {
      return chatText({
        provider,
        apiKey: k.key,
        model,
        baseUrl: k.baseUrl,
        system: opts.system,
        prompt: partsToPrompt(opts.parts),
        temperature: opts.temperature,
        timeoutMs,
      });
    }

    if (spec(provider).kind === "anthropic") {
      // Claude can read images, so the router will offer it for OCR — but this
      // adapter sends one text prompt, and partsToPrompt would drop the page
      // silently rather than loudly. Hand the call back to the router, which
      // moves it to the next provider (Gemini) instead of retrying every key
      // here for an answer none of them can give.
      if (opts.parts.some((p) => typeof p !== "string" && !("text" in p))) {
        throw new SchemaUnsupportedError("Claude keys here take text only; images stay on Gemini.");
      }
      // Again no `temperature` — see generateJson.
      return anthropicText({
        apiKey: k.key,
        model,
        baseUrl: k.baseUrl,
        system: opts.system,
        prompt: partsToPrompt(opts.parts),
        effort: EFFORT[opts.stage ?? ""],
        timeoutMs,
      });
    }

    if (spec(provider).kind === "claude-code") {
      // Pages and pictures go along as files Claude opens in the call's own
      // folder. A recording, or a file already uploaded to Gemini, cannot.
      const files: Attachment[] = [];
      for (const p of opts.parts) {
        if (typeof p === "string" || "text" in p) continue;
        const ext = "inlineData" in p ? ATTACHABLE[p.inlineData.mimeType] : undefined;
        if (!ext || !("inlineData" in p)) {
          throw new SchemaUnsupportedError("Claude on your plan reads pages and pictures, not recordings; those stay on Gemini.");
        }
        files.push({ ext, data: Buffer.from(p.inlineData.data, "base64") });
      }
      return claudeCodeText({
        apiKey: "",
        model,
        system: opts.system,
        prompt: partsToPrompt(opts.parts),
        effort: EFFORT[opts.stage ?? ""],
        timeoutMs,
        files,
      });
    }

    const ai = gemini(k, timeoutMs);
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: geminiParts(opts.parts) }],
      config: {
        temperature: opts.temperature ?? 0.2,
        ...(opts.system ? { systemInstruction: opts.system } : {}),
      },
    });

    const usage = usageOfGemini(res);
    const answered = modelOfGemini(res) ?? model;
    checkGeminiFinish(res.candidates?.[0]?.finishReason, res.promptFeedback?.blockReason);
    if (!res.text) throw new Error("Empty response.");
    return { data: res.text, usage, model: answered };
  };

  const modelOf = (k: ApiKey) => modelOfCall(k, opts);
  const { value, key } = opts.pin
    ? await withPinnedKey(opts.pin, call, modelOf)
    : await withRotation(candidates, call, { modelOf });

  bill(key.id, value.usage);
  noteModel(value.model);
  return value;
}

/** Embeddings, for entity-resolution candidates. */
export async function embed(texts: string[]): Promise<{ vectors: Float32Array[]; usage: Usage }> {
  const cfg = getConfig();
  const candidates = providersFor(undefined, { need: "embed" });

  // A hard pin, unlike every other call here: no text model can embed, so
  // there is nothing to fall back to when this one is out of quota. The ring
  // still rotates KEYS for a rate limit or a rejection — but a quota refusal
  // stops at the model, with every key left as it was.
  const { value, key } = await withRotation(candidates, async (k, model) => {
    const ai = gemini(k);
    const res = await ai.models.embedContent({
      model,
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
  }, { modelOf: () => cfg.embedModel, hardPin: true });

  bill(key.id, value.usage);
  return value;
}

/**
 * The file-upload API the SDK owns, and the key it is speaking as.
 *
 * The Files API hands back a URI that only the uploading key can read, so the
 * caller is told which key did the upload and the call that reads the file
 * asks for it by name.
 */
export function uploadClient(): { ai: GoogleGenAI; keyId: string } {
  const key = usableKeys("gemini")[0];
  if (!key) throw new MissingKeyError();
  return { ai: gemini(key, MEDIA_TIMEOUT_MS), keyId: key.id };
}

/** For calls that need a Gemini client but no particular key — counting tokens,
 *  say. */
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
  if (spec(provider).kind === "anthropic") {
    return validateAnthropicKey(apiKey, model, baseUrl);
  }
  if (spec(provider).kind === "claude-code") {
    return validateClaudeCode();
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
