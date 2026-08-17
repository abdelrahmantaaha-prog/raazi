import type { Schema } from "@google/genai";
import { spec, type ProviderId } from "../providers";
import { toJsonSchema, dropNulls } from "./schema";
import { TruncatedOutputError } from "./errors";

/**
 * One adapter for every provider that is not Gemini. Groq, Cerebras,
 * OpenRouter, Mistral and anything local (Ollama, LM Studio, vLLM) all speak
 * the OpenAI Chat Completions API, so they differ only by base URL and model
 * name — both of which live in lib/providers.ts.
 *
 * Deliberately written against `fetch` rather than the OpenAI SDK: the surface
 * used here is two endpoints, and a dependency that ships its own retry and
 * timeout behaviour would fight the queue's.
 */

export interface OpenAiUsage {
  tokensIn: number;
  tokensOut: number;
}

interface ChatResponse {
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

/** Errors carry the HTTP status and body so the key classifier can read them. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    body: string,
    public readonly retryAfterMs?: number
  ) {
    super(`${status} ${body.slice(0, 800)}`);
  }
}

async function post(
  provider: ProviderId,
  apiKey: string,
  path: string,
  body: unknown,
  baseUrlOverride?: string
): Promise<unknown> {
  const s = spec(provider);
  const base = (baseUrlOverride || s.baseUrl).replace(/\/$/, "");

  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      // OpenRouter asks callers to identify themselves; harmless elsewhere.
      ...(provider === "openrouter"
        ? { "HTTP-Referer": "https://localhost", "X-Title": "Corpus" }
        : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const retryAfter = res.headers.get("retry-after");
    // Groq reports the wait in a header rather than the body.
    const resetTokens = res.headers.get("x-ratelimit-reset-tokens");
    const resetRequests = res.headers.get("x-ratelimit-reset-requests");
    throw new HttpError(
      res.status,
      text,
      parseDelay(retryAfter) ?? parseDelay(resetTokens) ?? parseDelay(resetRequests)
    );
  }

  return res.json();
}

/** "20", "20s", "1m30s", "2.5s" -> milliseconds. */
function parseDelay(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const compound = /^(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(raw.trim());
  if (compound && (compound[1] || compound[2])) {
    return Math.ceil((Number(compound[1] ?? 0) * 60 + Number(compound[2] ?? 0)) * 1000);
  }
  const plain = Number(raw);
  return Number.isFinite(plain) ? Math.ceil(plain * 1000) : undefined;
}

function usageOf(res: ChatResponse): OpenAiUsage {
  return {
    tokensIn: res.usage?.prompt_tokens ?? 0,
    tokensOut: res.usage?.completion_tokens ?? 0,
  };
}

export async function chatJson<T>(opts: {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  system?: string;
  prompt: string;
  schema: Schema;
  temperature?: number;
}): Promise<{ data: T; usage: OpenAiUsage }> {
  const jsonSchema = toJsonSchema(opts.schema, true);

  const body = {
    model: opts.model,
    temperature: opts.temperature ?? 0.1,
    messages: [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: opts.prompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "corpus_result", strict: true, schema: jsonSchema },
    },
  };

  let res: ChatResponse;
  try {
    res = (await post(opts.provider, opts.apiKey, "/chat/completions", body, opts.baseUrl)) as ChatResponse;
  } catch (err) {
    // Not every endpoint implements json_schema. Fall back to plain JSON mode
    // with the schema described in the prompt rather than giving up — this is
    // the difference between a provider working and not.
    if (err instanceof HttpError && (err.status === 400 || err.status === 404 || err.status === 422)) {
      res = (await post(
        opts.provider,
        opts.apiKey,
        "/chat/completions",
        {
          ...body,
          response_format: { type: "json_object" },
          messages: [
            ...(opts.system ? [{ role: "system", content: opts.system }] : []),
            {
              role: "user",
              content: `${opts.prompt}\n\nReply with JSON only, matching this schema exactly:\n${JSON.stringify(jsonSchema)}`,
            },
          ],
        },
        opts.baseUrl
      )) as ChatResponse;
    } else {
      throw err;
    }
  }

  const choice = res.choices?.[0];
  if (choice?.finish_reason === "length") throw new TruncatedOutputError();

  const content = choice?.message?.content;
  if (!content) throw new Error(`Empty response (finish_reason=${choice?.finish_reason ?? "none"}).`);

  return { data: dropNulls(parseJson<T>(content)), usage: usageOf(res) };
}

export async function chatText(opts: {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  system?: string;
  prompt: string;
  temperature?: number;
}): Promise<{ data: string; usage: OpenAiUsage }> {
  const res = (await post(
    opts.provider,
    opts.apiKey,
    "/chat/completions",
    {
      model: opts.model,
      temperature: opts.temperature ?? 0.2,
      messages: [
        ...(opts.system ? [{ role: "system", content: opts.system }] : []),
        { role: "user", content: opts.prompt },
      ],
    },
    opts.baseUrl
  )) as ChatResponse;

  const choice = res.choices?.[0];
  if (choice?.finish_reason === "length") throw new TruncatedOutputError();
  const content = choice?.message?.content;
  if (!content) throw new Error("Empty response.");
  return { data: content, usage: usageOf(res) };
}

/** Some models still wrap JSON in a code fence despite being asked not to. */
function parseJson<T>(text: string): T {
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
  }
  try {
    return JSON.parse(s) as T;
  } catch {
    const first = s.search(/[[{]/);
    const last = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(s.slice(first, last + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    // A body that will not parse is usually one that was cut off.
    throw new TruncatedOutputError();
  }
}

/** Cheap liveness check used when a key is added. */
export async function validateOpenAiKey(
  provider: ProviderId,
  apiKey: string,
  model?: string,
  baseUrl?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await chatText({
      provider,
      apiKey,
      model: model || spec(provider).defaultModel,
      baseUrl,
      prompt: "ping",
      temperature: 0,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 401 || err.status === 403) {
        return { ok: false, error: "That key was rejected." };
      }
      if (err.status === 402) {
        return {
          ok: false,
          error:
            "The key is valid, but this account has no inference quota — the provider is asking for billing to be enabled.",
        };
      }
      if (err.status === 429) {
        return { ok: true, error: "Key is valid but currently rate limited." };
      }
      if (err.status === 404) {
        return { ok: false, error: "The endpoint or model name was not found." };
      }
      return { ok: false, error: err.message.slice(0, 200) };
    }
    return { ok: false, error: (err as Error).message.slice(0, 200) };
  }
}
