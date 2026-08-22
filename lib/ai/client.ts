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
import { brokerIsDown, isBrokerKey } from "../broker";
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

/**
 * A paced gate in front of every call. Free tiers cap requests per minute, and
 * waiting here is cheaper than eating a 429 and unwinding a task. The limit is
 * per key, so the gate is too: three keys buy three times the throughput.
 */
declare global {
  // eslint-disable-next-line no-var
  var __corpusLastCall: Map<string, number> | undefined;
}

async function pace(keyId: string) {
  const { requestsPerMinute } = getConfig();
  if (requestsPerMinute <= 0) return;
  if (!globalThis.__corpusLastCall) globalThis.__corpusLastCall = new Map();

  const minGap = 60_000 / requestsPerMinute;
  const last = globalThis.__corpusLastCall.get(keyId) ?? 0;
  const wait = last + minGap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  globalThis.__corpusLastCall.set(keyId, Date.now());
}

/**
 * Runs a call against the candidate providers, rotating keys within each.
 *
 * A key that hits its daily quota is set aside until it resets and the work
 * continues immediately on the next key — then, if that provider is exhausted
 * entirely, on the next provider. Only when nothing can answer does this give
 * up, reporting when the *first* key anywhere comes back so the worker sleeps
 * no longer than it must.
 */
async function withRotation<T>(
  candidates: ProviderId[],
  fn: (key: ApiKey) => Promise<T>,
  prefer?: string
): Promise<{ value: T; key: ApiKey }> {
  const tried = new Set<string>();
  let lastError: unknown;

  for (const provider of candidates) {
    for (;;) {
      const key = nextKey(provider, tried, prefer);
      if (!key) break; // this provider is spent; try the next one

      tried.add(key.id);
      await pace(key.id);

      try {
        const value = await fn(key);
        return { value, key };
      } catch (err) {
        lastError = err;

        // The broker being unreachable is not a refusal — it is the pool being
        // out of the picture for a while. Step past it and let this machine's
        // own keys take the work, which is what they were kept for.
        if (isBrokerKey(key.id) && brokerIsDown(err)) {
          markCooldown(key.id, 5 * 60_000, "The shared key pool is unreachable.");
          console.warn("[corpus] the key pool is unreachable; falling back to local keys");
          continue;
        }

        const failure = keyFailure(err);

        // The pool is a service, not a key with a daily allowance. Whatever it
        // just refused, it refused for this minute: it rotates thirty-seven
        // keys of its own and drops to a smaller model when one is spent, so
        // its answer changes minute to minute. Parking it for an hour — and
        // doubling that on the next refusal, as a real key deserves — is how a
        // single bad moment took the pool off the ring for the rest of the
        // night and left this machine's own spent keys to explain themselves.
        if (isBrokerKey(key.id)) {
          markCooldown(key.id, 60_000, `The shared key pool: ${"reason" in failure ? failure.reason : "no answer"}`);
          continue;
        }

        if (failure.kind === "daily") {
          markExhausted(key.id, failure.reason, getConfig().keyRetryMinutes);
          console.log(`[corpus] key "${key.label}" is out of quota for the day; trying the next one`);
          continue;
        }
        if (failure.kind === "invalid") {
          markInvalid(key.id, failure.reason);
          console.warn(`[corpus] key "${key.label}" was rejected; trying the next one`);
          continue;
        }
        if (failure.kind === "rate") {
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
function gemini(k: ApiKey): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: k.key,
    ...(k.baseUrl ? { httpOptions: { baseUrl: k.baseUrl } } : {}),
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
}): Promise<CallResult<T>> {
  const candidates = providersFor(opts.stage, { lang: opts.lang, sample: opts.sample });

  const { value, key } = await withRotation(candidates, async (k) => {
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
      });
    }

    const ai = gemini(k);
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
    checkGeminiFinish(res.candidates?.[0]?.finishReason, res.promptFeedback?.blockReason);
    if (!res.text) throw new Error("Empty response.");

    try {
      return { data: JSON.parse(res.text) as T, usage };
    } catch {
      throw new TruncatedOutputError();
    }
  });

  markUsed(key.id, value.usage.tokensIn, value.usage.tokensOut);
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
  /** Ask for a particular key first — see uploadClient(). */
  pin?: string;
}): Promise<CallResult<string>> {
  const candidates = providersFor(opts.stage, {
    need: opts.need,
    lang: opts.lang,
    sample: opts.sample,
  });

  const { value, key } = await withRotation(candidates, async (k) => {
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
      });
    }

    const ai = gemini(k);
    const res = await ai.models.generateContent({
      model: opts.model ?? modelFor(k),
      contents: [{ role: "user", parts: geminiParts(opts.parts) }],
      config: {
        temperature: opts.temperature ?? 0.2,
        ...(opts.system ? { systemInstruction: opts.system } : {}),
      },
    });

    const usage = usageOfGemini(res);
    checkGeminiFinish(res.candidates?.[0]?.finishReason, res.promptFeedback?.blockReason);
    if (!res.text) throw new Error("Empty response.");
    return { data: res.text, usage };
  }, opts.pin);

  markUsed(key.id, value.usage.tokensIn, value.usage.tokensOut);
  return value;
}

/** Embeddings, for entity-resolution candidates. */
export async function embed(texts: string[]): Promise<{ vectors: Float32Array[]; usage: Usage }> {
  const cfg = getConfig();
  const candidates = providersFor(undefined, { need: "embed" });

  const { value } = await withRotation(candidates, async (k) => {
    const ai = gemini(k);
    const res = await ai.models.embedContent({
      model: cfg.embedModel,
      contents: texts,
      config: { taskType: "SEMANTIC_SIMILARITY", outputDimensionality: 768 },
    });
    return {
      vectors: (res.embeddings ?? []).map((e) => new Float32Array(e.values ?? [])),
      usage: { tokensIn: 0, tokensOut: 0 },
    };
  });

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
  return { ai: gemini(key), keyId: key.id };
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
    const ai = new GoogleGenAI({ apiKey });
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
