import type { Schema } from "@google/genai";
import { spec, type ProviderId } from "../providers";
import { toJsonSchema, dropNulls } from "./schema";
import { TruncatedOutputError, SchemaUnsupportedError, isSchemaFailure } from "./errors";
import { unescapeModelJson } from "./escapes";

/**
 * The OpenAI Chat Completions adapter. One provider uses it now — Ollama on
 * this machine — but anything local that speaks the same API (LM Studio,
 * vLLM, another machine's GPU) differs only by base URL and model name, both
 * of which live in lib/providers.ts.
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
  /** What the endpoint says it ran — the resolved name, not the alias asked for. */
  model?: string;
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

/** The default ceiling on one call. A stalled socket used to freeze the
 *  single worker until someone restarted the server; three minutes is longer
 *  than any text call legitimately takes and shorter than anyone's patience. */
export const DEFAULT_TIMEOUT_MS = 180_000;

interface Posted {
  body: unknown;
}

async function post(
  provider: ProviderId,
  apiKey: string,
  path: string,
  body: unknown,
  baseUrlOverride?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Posted> {
  const s = spec(provider);
  const base = (baseUrlOverride || s.baseUrl).replace(/\/$/, "");

  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    // The whole exchange, headers to last byte. A hung connection surfaces
    // as a TimeoutError, which the worker's classifier reads as a network
    // blip and retries — rather than as the worker sitting there for good.
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const retryAfter = res.headers.get("retry-after");
    const resetTokens = res.headers.get("x-ratelimit-reset-tokens");
    const resetRequests = res.headers.get("x-ratelimit-reset-requests");
    throw new HttpError(
      res.status,
      text,
      parseDelay(retryAfter) ?? parseDelay(resetTokens) ?? parseDelay(resetRequests)
    );
  }

  return { body: await res.json() };
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

/**
 * Whether a 400 is the endpoint saying it does not do json_schema, as
 * opposed to every other reason a request can be bad. Re-posting on any 4xx
 * doubled the cost of a genuinely malformed request and hid what was wrong
 * with it behind a second, differently-shaped failure.
 */
function rejectsJsonSchema(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 400) return false;
  return /json_schema|response_format|structured output/i.test(err.message);
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
  timeoutMs?: number;
}): Promise<{ data: T; usage: OpenAiUsage; model?: string }> {
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

  let posted: Posted;
  try {
    posted = await post(opts.provider, opts.apiKey, "/chat/completions", body, opts.baseUrl, opts.timeoutMs);
  } catch (err) {
    // Not every endpoint implements json_schema. Fall back to plain JSON mode
    // with the schema described in the prompt rather than giving up — this is
    // the difference between a provider working and not. Only when the
    // endpoint actually says that is what it objects to, though.
    if (rejectsJsonSchema(err)) {
      posted = await post(
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
        opts.baseUrl,
        opts.timeoutMs
      );
    } else if (isSchemaFailure((err as HttpError)?.status, String((err as Error)?.message ?? "").toLowerCase())) {
      // The endpoint understands json_schema and this model could not fill it.
      // A second key on the same provider reaches the same model, so this is
      // raised as its own error and the router moves to the next provider.
      throw new SchemaUnsupportedError(String((err as Error).message).slice(0, 300));
    } else {
      throw err;
    }
  }

  const res = posted.body as ChatResponse;
  const choice = res.choices?.[0];
  if (choice?.finish_reason === "length") throw new TruncatedOutputError();

  const content = choice?.message?.content;
  if (!content) throw new Error(`Empty response (finish_reason=${choice?.finish_reason ?? "none"}).`);

  return { data: dropNulls(parseJson<T>(content)), usage: usageOf(res), model: res.model };
}

export async function chatText(opts: {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  system?: string;
  prompt: string;
  temperature?: number;
  timeoutMs?: number;
}): Promise<{ data: string; usage: OpenAiUsage; model?: string }> {
  const posted = await post(
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
    opts.baseUrl,
    opts.timeoutMs
  );

  const res = posted.body as ChatResponse;
  const choice = res.choices?.[0];
  if (choice?.finish_reason === "length") throw new TruncatedOutputError();
  const content = choice?.message?.content;
  if (!content) throw new Error("Empty response.");
  return { data: content, usage: usageOf(res), model: res.model };
}

/** Some models still wrap JSON in a code fence despite being asked not to. */
function parseJson<T>(text: string): T {
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
  }
  try {
    return unescapeModelJson(JSON.parse(s) as T);
  } catch {
    const first = s.search(/[[{]/);
    const last = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    if (first >= 0 && last > first) {
      try {
        return unescapeModelJson(JSON.parse(s.slice(first, last + 1)) as T);
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
