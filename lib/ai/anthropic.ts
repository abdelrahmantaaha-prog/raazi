import Anthropic from "@anthropic-ai/sdk";
import type { Schema } from "@google/genai";
import { toJsonSchema, dropNulls } from "./schema";
import { TruncatedOutputError, SafetyBlockError } from "./errors";

/**
 * The Anthropic adapter.
 *
 * Claude speaks neither of the two shapes this app already knows. It is not
 * Gemini's `generateContent`, and it is not the OpenAI Chat Completions shape
 * that Groq, Mistral and Ollama share — so `custom` cannot reach it however
 * the base URL is set. Hence a third adapter rather than a row in the table.
 *
 * Three differences from the other two are load-bearing:
 *
 *  - **`temperature` is rejected.** Sonnet 5, Opus 5 and the whole 4.7+ family
 *    return a 400 for any sampling parameter. Every call in this pipeline
 *    passes one, so it is dropped here rather than at each of the fourteen
 *    call sites. Determinism now comes from `effort`, which is what replaced
 *    it.
 *  - **Thinking is on by default and costs output tokens.** Left alone, a
 *    structured extraction spends its budget reasoning about a passage it was
 *    asked only to index. Every stage here sets an explicit effort, and the
 *    cheap mechanical ones sit at `low`.
 *  - **Structured output is `output_config.format`,** not a response schema
 *    and not a tool call. The JSON Schema translation already written for the
 *    OpenAI path is reused, so a Gemini `Schema` reaches Claude unchanged.
 */

export interface AnthropicCall {
  apiKey: string;
  model: string;
  baseUrl?: string;
  system?: string;
  prompt: string;
  /** The stage's effort, chosen by the caller. See EFFORT below. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AnthropicUsage {
  tokensIn: number;
  tokensOut: number;
}

/**
 * How hard Claude thinks, per stage.
 *
 * Effort is this API's cost dial and it replaced temperature, so the mapping
 * is deliberate rather than a default. Reading a passage into a schema is
 * mechanical and wants `low`; writing an entry is the judgement this app
 * exists for and gets `high`; checking an entry against its own citations is
 * the one place being thorough is the entire point.
 */
export const EFFORT: Record<string, AnthropicCall["effort"]> = {
  extract: "low",
  tag: "low",
  context: "low",
  resolve: "medium",
  cards: "medium",
  ask: "high",
  entry: "high",
};

/** Room for the answer. Extraction returns long JSON; a tag returns a line. */
const MAX_TOKENS = 16_000;

function client(opts: AnthropicCall): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey,
    // The shared pool proxies Claude too, when it is pointed at one.
    ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    timeout: opts.timeoutMs ?? 180_000,
    // Retries are the worker's job: it owns the backoff, the key rotation and
    // the token ledger, and a retry the SDK hides is a retry the run cannot
    // account for.
    maxRetries: 0,
  });
}

function usageOf(res: { usage?: { input_tokens?: number; output_tokens?: number } }): AnthropicUsage {
  return {
    tokensIn: res.usage?.input_tokens ?? 0,
    tokensOut: res.usage?.output_tokens ?? 0,
  };
}

/**
 * Reads the stop reason the same way the Gemini path does, so the worker's
 * error taxonomy sees one vocabulary whichever provider answered.
 *
 * `refusal` is Claude's own: the request was declined by a safety classifier
 * and arrives as a 200. Treated as a safety block, which makes the worker skip
 * the passage and carry on with the book rather than failing the run.
 */
export function checkStop(stopReason: string | null | undefined, detail?: unknown) {
  if (stopReason === "max_tokens") throw new TruncatedOutputError();
  if (stopReason === "refusal") {
    const category =
      detail && typeof detail === "object" && "category" in detail
        ? String((detail as { category?: unknown }).category ?? "refusal")
        : "refusal";
    throw new SafetyBlockError(category);
  }
}

/** The text of a response, ignoring the thinking blocks that precede it. */
function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

export async function anthropicJson<T>(
  opts: AnthropicCall & { schema: Schema }
): Promise<{ data: T; usage: AnthropicUsage; model: string }> {
  const res = await client(opts).messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? MAX_TOKENS,
    ...(opts.system ? { system: opts.system } : {}),
    messages: [{ role: "user", content: opts.prompt }],
    output_config: {
      effort: opts.effort ?? "medium",
      format: { type: "json_schema", schema: toJsonSchema(opts.schema) as Record<string, unknown> },
    },
  });

  checkStop(res.stop_reason, res.stop_details);
  const text = textOf(res.content as { type: string; text?: string }[]);
  if (!text) throw new Error(`Empty response (stop_reason=${res.stop_reason ?? "none"}).`);

  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    // A JSON response that will not parse is a truncated one nine times in
    // ten, and the worker knows how to split an oversized chunk.
    throw new TruncatedOutputError();
  }
  // The schema translation makes optionals nullable, exactly as on the OpenAI
  // path; the nulls are stripped so handlers see the shape they expect.
  return { data: dropNulls(parsed), usage: usageOf(res), model: res.model };
}

export async function anthropicText(
  opts: AnthropicCall
): Promise<{ data: string; usage: AnthropicUsage; model: string }> {
  const res = await client(opts).messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? MAX_TOKENS,
    ...(opts.system ? { system: opts.system } : {}),
    messages: [{ role: "user", content: opts.prompt }],
    output_config: { effort: opts.effort ?? "medium" },
  });

  checkStop(res.stop_reason, res.stop_details);
  const text = textOf(res.content as { type: string; text?: string }[]);
  if (!text) throw new Error(`Empty response (stop_reason=${res.stop_reason ?? "none"}).`);
  return { data: text, usage: usageOf(res), model: res.model };
}

/**
 * Whether a key works, without spending anything worth counting.
 *
 * One token of output on the cheapest model: enough to prove the key
 * authenticates and the account can be billed, which is the whole question.
 */
export async function validateAnthropicKey(
  apiKey: string,
  model?: string,
  baseUrl?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await client({ apiKey, model: "", prompt: "", baseUrl, timeoutMs: 30_000 }).messages.create({
      model: model || "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    return { ok: true };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/authentication|invalid.*api.*key|401/i.test(raw)) {
      return { ok: false, error: "Anthropic rejected that key." };
    }
    if (/credit|billing|402/i.test(raw)) {
      return { ok: false, error: "The key is valid but the account has no credit." };
    }
    if (/rate.?limit|429/i.test(raw)) {
      return { ok: true, error: "Key is valid but rate limited right now." };
    }
    return { ok: false, error: raw.slice(0, 200) };
  }
}
