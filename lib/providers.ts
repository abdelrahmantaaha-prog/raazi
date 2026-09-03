/**
 * Who can answer which kind of question.
 *
 * Roughly 88% of this app's token spend is the `extract` stage: plain text in,
 * structured JSON out, no images and no audio. That work can go to whichever
 * free tier is most generous. OCR, transcription and embeddings cannot — very
 * few free providers do them at all, which is why Gemini stays the backbone
 * rather than being replaced.
 *
 * Everything except Gemini and Anthropic speaks the OpenAI Chat Completions
 * API, so one adapter covers all of those and adding another is a row in this
 * table. Anthropic is the exception that needed a third adapter: its request
 * shape is neither of the two, so no base URL can reach it through `custom`.
 */

export type ProviderId =
  | "gemini"
  | "groq"
  | "cerebras"
  | "openrouter"
  | "mistral"
  | "anthropic"
  | "custom";

export interface Capabilities {
  /** Reliable structured output against a supplied JSON schema. */
  json: boolean;
  /** Can read PDF pages and images — needed for scanned books. */
  vision: boolean;
  /** Can transcribe audio and video. */
  audio: boolean;
  /** Provides an embeddings endpoint. */
  embed: boolean;
}

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  /** How the request is shaped. */
  kind: "gemini" | "openai" | "anthropic";
  baseUrl: string;
  defaultModel: string;
  keysUrl: string;
  capabilities: Capabilities;
  /** One line explaining the trade-off, shown in Settings. */
  note: string;
  /** Free-tier limits at the time of writing, for the UI to show honestly —
   *  or, for a provider that has no free tier, what it costs instead. Settings
   *  prints this verbatim, so a paid provider has to say so here or it reads
   *  as free. */
  freeTier: string;
  /** True when extra keys genuinely multiply your quota. Groq counts usage per
   *  organisation, so a second key there buys nothing. */
  keysMultiply: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    kind: "gemini",
    baseUrl: "",
    defaultModel: "gemini-flash-latest",
    keysUrl: "https://aistudio.google.com/apikey",
    capabilities: { json: true, vision: true, audio: true, embed: true },
    note: "The only free tier that also does OCR, transcription and embeddings. Strong on Arabic.",
    freeTier: "~1,500 requests/day, 10/min",
    keysMultiply: true,
  },
  groq: {
    id: "groq",
    label: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    // Groq retired the Llama 3.3 line this default used to name, and a model
    // that no longer exists reads as a 404 rather than as a missing model —
    // check /v1/models if this one goes the same way.
    defaultModel: "openai/gpt-oss-120b",
    keysUrl: "https://console.groq.com/keys",
    capabilities: { json: true, vision: false, audio: false, embed: false },
    note: "Very fast and a generous daily allowance, but a low tokens-per-minute ceiling.",
    freeTier: "~14,400 requests/day, 30/min, 6k tokens/min",
    keysMultiply: false,
  },
  cerebras: {
    id: "cerebras",
    label: "Cerebras",
    kind: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    // Their catalogue turns over — the Llama models this once defaulted to are
    // gone. Check /v1/models if a key reports the model was not found.
    defaultModel: "gpt-oss-120b",
    keysUrl: "https://cloud.cerebras.ai",
    capabilities: { json: true, vision: false, audio: false, embed: false },
    note: "Very high throughput, but inference now needs billing enabled on the account — a key alone may return 402.",
    freeTier: "billing required on newer accounts",
    keysMultiply: false,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    keysUrl: "https://openrouter.ai/keys",
    capabilities: { json: true, vision: false, audio: false, embed: false },
    note: "Many models behind one key, but free models rotate out without notice — bad for repeatable research.",
    freeTier: "50 requests/day free (1,000 after a one-off $10)",
    keysMultiply: false,
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    keysUrl: "https://console.mistral.ai/api-keys",
    capabilities: { json: true, vision: false, audio: false, embed: true },
    note: "A huge monthly token allowance at only ~2 requests/minute — and the free tier requires opting into training on your data.",
    freeTier: "~1B tokens/month, ~2 requests/min",
    keysMultiply: false,
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    // The SDK already knows where the API lives; a base URL here is only for
    // pointing the ring at a proxy.
    baseUrl: "",
    defaultModel: "claude-sonnet-5",
    keysUrl: "https://console.anthropic.com/settings/keys",
    // Claude reads images, so a scanned page is not out of the question — but
    // it does not transcribe audio and has no embeddings endpoint, which is
    // why Gemini keeps those two whatever the routing says.
    capabilities: { json: true, vision: true, audio: false, embed: false },
    note: "The only paid service here, and worth it in one place: writing an entry and checking it against its own citations. Put the reading stages on it and you are paying premium rates to index passages.",
    // Worded to read correctly after Settings' "Free tier:" label, which is
    // the only place this string appears.
    freeTier:
      "none, it is paid only — per million tokens, Sonnet 5 $2 in / $10 out, Opus 5 $5 / $25, Haiku 4.5 $1 / $5",
    // Anthropic counts spend against the account, so a second key is a second
    // label on the same bill.
    keysMultiply: false,
  },
  custom: {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    keysUrl: "",
    capabilities: { json: true, vision: false, audio: false, embed: false },
    note: "Anything speaking the OpenAI API — Ollama, LM Studio, vLLM. No quota at all, and nothing leaves the machine.",
    freeTier: "whatever your hardware allows",
    keysMultiply: false,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** The stages that can be routed. OCR, transcription and embeddings are not
 *  here: they need capabilities the alternatives do not have. */
export type Stage = "extract" | "resolve" | "entry" | "tag" | "ask" | "cards";
export const STAGES: Stage[] = ["extract", "resolve", "entry", "tag", "ask", "cards"];

export const STAGE_LABEL: Record<Stage, string> = {
  extract: "Reading passages",
  resolve: "Matching names",
  entry: "Writing entries",
  tag: "Filing sources",
  ask: "Answering questions",
  cards: "Making study cards",
};

export const STAGE_NOTE: Record<Stage, string> = {
  extract:
    "The bulk of the work — around 88% of all tokens. Moving this is what makes your Gemini quota last.",
  resolve: "Occasional and small. Judgement-heavy, so a weaker model costs accuracy.",
  entry: "Where the writing quality shows. Worth keeping on the strongest model you have.",
  tag: "One short call per source. Barely worth routing.",
  ask: "One call per question, over the passages retrieved for it. Answer quality shows here.",
  cards: "A batch per set of cards. A weaker model writes duller questions, not wrong ones.",
};

export function spec(id: ProviderId): ProviderSpec {
  return PROVIDERS[id] ?? PROVIDERS.gemini;
}
