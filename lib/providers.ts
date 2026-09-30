/**
 * Who can answer which kind of question.
 *
 * Three, deliberately. The free-tier scramble — Groq, Cerebras, OpenRouter,
 * Mistral and a shared key pool in front of them — is gone: it bought quota at
 * the price of never knowing which model wrote an entry, and for research you
 * intend to cite that is the wrong trade. What is left is Gemini for the
 * reading, Claude for the writing, and this machine's own GPU for whatever you
 * would rather never send anywhere.
 *
 * OCR, transcription and embeddings stay on Gemini whatever the routing says:
 * it is the only one of the three that does all of them.
 *
 * Gemini and Ollama each have an adapter; Ollama speaks the OpenAI Chat
 * Completions API, so pointing that adapter at another local server is a base
 * URL, not code. Anthropic needed a third adapter — its request shape is
 * neither of the other two. Claude on the Claude plan is a fourth: the same
 * model, reached through Claude Code rather than the API, so it is limited
 * by the subscription instead of billed by the token.
 */

export type ProviderId = "gemini" | "anthropic" | "claude-code" | "ollama";

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
  kind: "gemini" | "openai" | "anthropic" | "claude-code";
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
  /** True when extra keys genuinely multiply your quota. Anthropic bills the
   *  account, so a second key there is a second label on one bill. */
  keysMultiply: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    kind: "gemini",
    baseUrl: "",
    // The head of MODEL_RING. Explicit rather than an alias so an entry can
    // say which model wrote it and still be true a month later.
    defaultModel: "gemini-3.8-flash",
    keysUrl: "https://aistudio.google.com/apikey",
    capabilities: { json: true, vision: true, audio: true, embed: true },
    note: "The only free tier that also does OCR, transcription and embeddings. Strong on Arabic.",
    freeTier: "~1,500 requests/day, 10/min",
    keysMultiply: true,
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
  "claude-code": {
    id: "claude-code",
    label: "Claude (your plan)",
    kind: "claude-code",
    baseUrl: "",
    // By its full name: the "sonnet" alias answered with Sonnet 5 on a Pro plan
    // (30 Sep 2026). Claude Code reports the version that answered on every call.
    defaultModel: "claude-sonnet-5-5",
    keysUrl: "",
    // Text only: the adapter sends one prompt through Claude Code, so pages
    // and recordings stay on Gemini.
    capabilities: { json: true, vision: false, audio: false, embed: false },
    note: "Claude on your Claude subscription, through Claude Code on this machine — no per-token bill, but every call counts against the same five-hour and weekly limits as your own chats. Claude Code must be installed and signed in; any text works as the key. Worth it for the brief and for writing entries; reading passages would spend the week's allowance in a book or two.",
    freeTier: "no bill — your plan's usage limits, shared with your own Claude use; when they run out the work moves to Gemini until they reset",
    keysMultiply: false,
  },
  ollama: {
    id: "ollama",
    label: "Local (Ollama)",
    kind: "openai",
    // The environment wins so a run can point at another machine's GPU, or at
    // LM Studio or vLLM — anything speaking the OpenAI API answers here.
    baseUrl: process.env.OLLAMA_BASE_URL?.replace(/\/+$/, "") || "http://127.0.0.1:11434/v1",
    // What is actually pulled on this machine (see Mutarjim's bench, Sep 2026).
    defaultModel: "qwen3.5:9b",
    keysUrl: "https://ollama.com/library/qwen3.5",
    capabilities: { json: true, vision: false, audio: false, embed: false },
    note: "Runs on this machine's GPU — free, offline, and nothing leaves the computer. Any text works as the key.",
    freeTier: "unlimited; the model has to be pulled first (ollama pull qwen3.5:9b)",
    keysMultiply: false,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/**
 * The providers Settings offers a new key for. The pay-per-token Claude API
 * is not one of them any more: Claude is reached on your plan, through Claude
 * Code, and two rows both called Claude — one free, one billed — was a trap.
 * The adapter stays, so a key already on the ring keeps working.
 */
export const OFFERED_PROVIDER_IDS: ProviderId[] = PROVIDER_IDS.filter((id) => id !== "anthropic");

/**
 * The models a provider will answer with, best first.
 *
 * Free-tier quota on Gemini is counted per model, not per key — so when the
 * model you are asking for is spent, every one of your keys is spent for it and
 * none of them is spent for anything else. Rotating thirty-five keys through an
 * exhausted model is thirty-five round trips to the same refusal, which is what
 * the app spent 6 September doing. The ring therefore cycles models as well as
 * keys: a refusal on quota sets the model aside and the same key asks the next
 * one down immediately.
 *
 * Measured, on one key, at one moment, 6 September 2026:
 *
 *   gemini-flash-latest     429  RESOURCE_EXHAUSTED
 *   gemini-3.8-flash        503  busy
 *   gemini-3.7-flash        200
 *   gemini-3.6-flash        200
 *   gemini-3.5-flash        200
 *   gemini-3.5-flash-lite   200
 *
 * Which settles two things. The allowance really is per model — the same key,
 * seconds apart, refused for one and served by the next. And the useful
 * fallback is the version below, not the lite tier: the first ring here went
 * straight from the alias to flash-lite and stepped over four full-flash
 * models that were sitting there unspent.
 *
 * No aliases. `gemini-flash-latest` was the first entry and the only one out of
 * quota, and an alias is the wrong thing for this library anyway: it moves when
 * Google ships, so two entries written a month apart come from different models
 * with nothing on the page to say so. Explicit versions, newest first, and the
 * lite tier at the back as the last thing before the local model.
 */
export const MODEL_RING: Partial<Record<ProviderId, string[]>> = {
  gemini: [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
  ],
  // One model each, and neither meters the way Gemini's free tier does: Claude
  // bills rather than refuses, and Ollama is a file on this disk.
  anthropic: ["claude-sonnet-5"],
  "claude-code": ["claude-sonnet-5-5"],
  ollama: ["qwen3.5:9b"],
};

/** Every model this provider might use, for the settings page and for tests. */
export function modelsFor(id: ProviderId): string[] {
  const ring = MODEL_RING[id] ?? [];
  return ring.length ? ring : [spec(id).defaultModel];
}

/**
 * The stages that can be routed. OCR, transcription and embeddings are not
 * here: they need capabilities the alternatives do not have.
 *
 * `verify` and `brief` are separate knobs because of what happened when they
 * were not. Both used to travel under `entry`, along with the coherence pass —
 * so pointing "writing entries" at Claude silently pointed four different
 * kinds of work at it, and the bill for two days was $20 rather than the $2 a
 * day the estimate said. A routing table that hides three quarters of what it
 * routes is not a routing table.
 */
export type Stage = "extract" | "resolve" | "entry" | "verify" | "tag" | "brief" | "group";
export const STAGES: Stage[] = ["extract", "resolve", "entry", "verify", "tag", "brief", "group"];

export const STAGE_LABEL: Record<Stage, string> = {
  extract: "Reading passages",
  resolve: "Matching names",
  entry: "Writing entries",
  verify: "Checking entries",
  tag: "Filing sources",
  brief: "Writing the brief",
  group: "Grouping the inbox",
};

export const STAGE_NOTE: Record<Stage, string> = {
  extract:
    "The bulk of the work — around 88% of all calls. Volume and schema reliability matter here more than judgement.",
  resolve: "Occasional and small. Judgement-heavy, so a weaker model costs accuracy.",
  entry: "Where the writing shows. A local model does this well and costs nothing but time.",
  verify:
    "Reads each finished entry back against its own citations, and the coherence pass with it. Runs about as often as writing does, so it costs about as much — which is why it has its own line.",
  tag: "One short call per source. Barely worth routing.",
  brief:
    "A handful of calls a week, over every passage the week collected. The one place long context beats everything else, and the one you present from.",
  group:
    "Reads only headlines and says which are one story. A few thousand tokens a pass, a few passes a day; the cheapest model on the ring is asked first, and the local one does it for nothing.",
};

export function spec(id: ProviderId): ProviderSpec {
  return PROVIDERS[id] ?? PROVIDERS.gemini;
}
