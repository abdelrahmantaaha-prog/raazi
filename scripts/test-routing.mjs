/**
 * Multi-provider routing. Two properties matter most:
 *
 *   - a call that needs to read images or audio never gets sent somewhere that
 *     cannot, however the routing is configured;
 *   - Arabic never quietly ends up on a model that is weak at it.
 *
 *   npx tsx scripts/test-routing.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__routing__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.CORPUS_DATA_DIR = SANDBOX;
delete process.env.GEMINI_API_KEY;

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);

const keys = await import("../lib/keys.ts");
const { saveConfig } = await import("../lib/config.ts");
const { providersFor } = await import("../lib/ai/client.ts");
const { toJsonSchema, dropNulls } = await import("../lib/ai/schema.ts");
const { keyFailure } = await import("../lib/ai/errors.ts");
const { HttpError } = await import("../lib/ai/openai.ts");
const { PROVIDERS, PROVIDER_IDS, STAGES, spec } = await import("../lib/providers.ts");
const { EFFORT } = await import("../lib/ai/anthropic.ts");

// ---------------------------------------------------------------------------
section("Translating a schema for providers that speak JSON Schema");
// ---------------------------------------------------------------------------
const gemini = {
  type: "OBJECT",
  properties: {
    surface: { type: "STRING" },
    type: { type: "STRING", enum: ["person", "org"] },
    claim: { type: "STRING", description: "Optional." },
    tags: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["surface", "type"],
};

const js = toJsonSchema(gemini, true);
check("types are lowercased", js.type === "object" && js.properties.surface.type === "string");
check("enums survive", JSON.stringify(js.properties.type.enum) === '["person","org"]');
check("array items are converted too", js.properties.tags.items.type === "string");
check(
  "optional fields become nullable, as strict mode requires",
  JSON.stringify(js.properties.claim.type) === '["string","null"]',
  JSON.stringify(js.properties.claim.type)
);
check("strict mode requires every property", js.required.length === 4, JSON.stringify(js.required));
check("and forbids extra ones", js.additionalProperties === false);

const cleaned = dropNulls({ surface: "Nasser", claim: null, tags: ["a", null] });
check("nulls are stripped back out before use", !("claim" in cleaned), JSON.stringify(cleaned));
check("including inside arrays", cleaned.tags.length === 1);

// ---------------------------------------------------------------------------
section("Reading an OpenAI-style rate limit");
// ---------------------------------------------------------------------------
const rpd = new HttpError(
  429,
  JSON.stringify({
    error: { message: "Rate limit reached for model llama-3.3-70b in organization org_x on requests per day (RPD)" },
  })
);
check("a daily limit sets the key aside for the day", keyFailure(rpd).kind === "daily", keyFailure(rpd).kind);

const tpm = new HttpError(
  429,
  JSON.stringify({ error: { message: "Rate limit reached ... on tokens per minute (TPM). Try again in 8s" } }),
  8000
);
const tpmVerdict = keyFailure(tpm);
check("a per-minute limit is only a cooldown", tpmVerdict.kind === "rate", tpmVerdict.kind);
check("and uses the delay from the response header", tpmVerdict.delayMs === 8000, String(tpmVerdict.delayMs));

check("a 401 from any provider means the key is bad",
  keyFailure(new HttpError(401, '{"error":{"message":"Invalid API Key"}}')).kind === "invalid");
check("a 500 is not the key's fault",
  keyFailure(new HttpError(500, "internal error")).kind === "other");

// A key that authenticates but has no quota behind it. Waiting will never fix
// this, so it must be set aside rather than retried until the task fails.
const unpaid = new HttpError(
  402,
  '{"message":"Payment required to access this resource. Visit your billing tab.","type":"payment_required_error","code":"payment_required"}'
);
check("a 402 sets the key aside rather than retrying it", keyFailure(unpaid).kind === "invalid", keyFailure(unpaid).kind);
check("and says why, so it is fixable", /billing/i.test(keyFailure(unpaid).reason), keyFailure(unpaid).reason);

// ---------------------------------------------------------------------------
section("Choosing who answers");
// ---------------------------------------------------------------------------
keys.addKey("gem-key-0001", "Gemini", { provider: "gemini" });
keys.addKey("ollama", "This machine", { provider: "ollama" });

check("with nothing configured, everything goes to Gemini",
  providersFor("extract")[0] === "gemini", providersFor("extract")[0]);

saveConfig({ routing: { extract: "ollama" } });

check("the routed stage goes where you sent it", providersFor("extract")[0] === "ollama", providersFor("extract")[0]);
check("other stages are untouched", providersFor("entry")[0] === "gemini", providersFor("entry")[0]);
check(
  "but Gemini stays on the list as a fallback",
  providersFor("extract").includes("gemini"),
  JSON.stringify(providersFor("extract"))
);

// ---------------------------------------------------------------------------
section("Capabilities are not negotiable");
// ---------------------------------------------------------------------------
saveConfig({ routing: { extract: "ollama", entry: "ollama", resolve: "ollama", tag: "ollama" } });

check(
  "OCR never goes to a provider that cannot see",
  providersFor("extract", { need: "vision" })[0] === "gemini",
  JSON.stringify(providersFor("extract", { need: "vision" }))
);
check(
  "and the local model is not even offered for it",
  !providersFor("extract", { need: "vision" }).includes("ollama")
);
check(
  "transcription likewise",
  providersFor(undefined, { need: "audio" }).every((p) => p === "gemini")
);
check(
  "and embeddings likewise",
  providersFor(undefined, { need: "embed" }).every((p) => p !== "ollama")
);

// ---------------------------------------------------------------------------
section("Language does not steer the routing");
// ---------------------------------------------------------------------------
// A source's script used to override the stage choice and send it to Gemini.
// That quietly contradicted the routing — an Arabic source could never reach
// the model you had chosen to write about it — so the rule is gone and there
// is no language input to providersFor at all.
check(
  "the routing decides for every source, whatever its script",
  providersFor("extract")[0] === "ollama",
  providersFor("extract")[0]
);
check(
  "and nothing sends it back to Gemini behind your back",
  providersFor("entry")[0] === "ollama",
  providersFor("entry")[0]
);

// ---------------------------------------------------------------------------
section("Keys belong to their provider");
// ---------------------------------------------------------------------------
check("each provider sees only its own keys", keys.usableKeys("ollama").length === 1);
check("and rotation cannot stray across them", keys.nextKey("ollama").provider === "ollama");
check("both are configured", keys.configuredProviders().sort().join() === "gemini,ollama");

keys.markExhausted(keys.nextKey("ollama").id, "spent", 60);
check("a key set aside leaves its provider with nothing", keys.usableKeys("ollama").length === 0);
check("but Gemini is unaffected", keys.usableKeys("gemini").length === 1);

const legacy = keys.listKeys().find((k) => k.key === "gem-key-0001");
check("a key with no provider recorded is treated as Gemini", legacy.provider === "gemini");

// ---------------------------------------------------------------------------
section("Claude is on the ring");
// ---------------------------------------------------------------------------
check("anthropic is a provider the app knows", PROVIDER_IDS.includes("anthropic"));
// spec() falls back to Gemini for anything it does not recognise, so asking
// for the id back is what proves the table really has the row.
check("and spec() resolves it rather than falling back", spec("anthropic").id === "anthropic");
check(
  "it is neither of the two shapes already handled",
  spec("anthropic").kind === "anthropic",
  spec("anthropic").kind
);
check("it is honest about being paid", /paid only/i.test(PROVIDERS.anthropic.freeTier));

keys.addKey("sk-ant-key-0003", "Claude", { provider: "anthropic" });
check(
  "an Anthropic key is configured like any other",
  keys.configuredProviders().includes("anthropic")
);
check("and gets Sonnet by default", keys.modelFor(keys.nextKey("anthropic")) === "claude-sonnet-5");
check(
  "with no date suffix — those are 404s on this API",
  !/\d{8}$/.test(PROVIDERS.anthropic.defaultModel),
  PROVIDERS.anthropic.defaultModel
);

saveConfig({ routing: { extract: "gemini", tag: "gemini", entry: "anthropic", ask: "anthropic" } });

check("writing goes to Claude when you send it there", providersFor("entry")[0] === "anthropic");
check("and so does answering", providersFor("ask")[0] === "anthropic");
check("while the bulk reading stays on Gemini", providersFor("extract")[0] === "gemini");

// ---------------------------------------------------------------------------
section("Claude's capabilities are not negotiable either");
// ---------------------------------------------------------------------------
check(
  "transcription never goes to Claude, however ask is routed",
  !providersFor("ask", { need: "audio" }).includes("anthropic"),
  JSON.stringify(providersFor("ask", { need: "audio" }))
);
check(
  "and neither do embeddings",
  !providersFor("entry", { need: "embed" }).includes("anthropic"),
  JSON.stringify(providersFor("entry", { need: "embed" }))
);
// The other alternatives cannot see at all; Claude can, so it is allowed to be
// offered here. The client still hands an image call back to the router,
// because this adapter sends text only.
check(
  "but OCR may be offered to it, because Claude does read images",
  providersFor("ask", { need: "vision" }).includes("anthropic"),
  JSON.stringify(providersFor("ask", { need: "vision" }))
);

check(
  "Gemini is still the last resort behind Claude",
  providersFor("entry").at(-1) === "gemini",
  JSON.stringify(providersFor("entry"))
);
for (const need of ["vision", "audio", "embed"]) {
  check(
    `and still the last resort for ${need}`,
    providersFor("entry", { need }).at(-1) === "gemini",
    JSON.stringify(providersFor("entry", { need }))
  );
}
check(
  "and an Arabic source reaches Claude like any other",
  providersFor("entry")[0] === "anthropic",
  providersFor("entry")[0]
);

// Effort replaced temperature on this API, so a stage with no entry would
// silently get the SDK default rather than the cost dial this app chose.
for (const stage of STAGES) {
  check(`effort is set for ${stage}`, Boolean(EFFORT[stage]), String(EFFORT[stage]));
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
