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
const { providersFor, isNonLatin } = await import("../lib/ai/client.ts");
const { toJsonSchema, dropNulls } = await import("../lib/ai/schema.ts");
const { keyFailure } = await import("../lib/ai/errors.ts");
const { HttpError } = await import("../lib/ai/openai.ts");

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
keys.addKey("groq-key-0002", "Groq", { provider: "groq" });

check("with nothing configured, everything goes to Gemini",
  providersFor("extract")[0] === "gemini", providersFor("extract")[0]);

saveConfig({ routing: { extract: "groq" }, nonLatinProvider: "gemini" });

check("the routed stage goes where you sent it", providersFor("extract")[0] === "groq", providersFor("extract")[0]);
check("other stages are untouched", providersFor("entry")[0] === "gemini", providersFor("entry")[0]);
check(
  "but Gemini stays on the list as a fallback",
  providersFor("extract").includes("gemini"),
  JSON.stringify(providersFor("extract"))
);

// ---------------------------------------------------------------------------
section("Capabilities are not negotiable");
// ---------------------------------------------------------------------------
saveConfig({ routing: { extract: "groq", entry: "groq", resolve: "groq", tag: "groq" } });

check(
  "OCR never goes to a provider that cannot see",
  providersFor("extract", { need: "vision" })[0] === "gemini",
  JSON.stringify(providersFor("extract", { need: "vision" }))
);
check(
  "and Groq is not even offered for it",
  !providersFor("extract", { need: "vision" }).includes("groq")
);
check(
  "transcription likewise",
  providersFor(undefined, { need: "audio" }).every((p) => p === "gemini")
);
check(
  "and embeddings likewise",
  providersFor(undefined, { need: "embed" }).every((p) => p !== "groq")
);

// ---------------------------------------------------------------------------
section("Arabic stays where it is understood");
// ---------------------------------------------------------------------------
check("a declared Arabic source is recognised", isNonLatin("ar"));
check("a declared English one is not", !isNonLatin("en"));
check(
  "an undeclared Arabic passage is recognised from its text",
  isNonLatin(undefined, "قرر جمال عبد الناصر تأميم قناة السويس في يوليو 1956")
);
check(
  "an English passage quoting one Arabic word is not",
  !isNonLatin(undefined, "Nasser announced the nationalisation of the canal, calling it تأميم, in July 1956.")
);

check(
  "so an Arabic source overrides the routing",
  providersFor("extract", { lang: "ar" })[0] === "gemini",
  providersFor("extract", { lang: "ar" })[0]
);
check(
  "even when only the text gives it away",
  providersFor("extract", { sample: "قرر جمال عبد الناصر تأميم قناة السويس" })[0] === "gemini"
);
check(
  "while English still goes to the cheap provider",
  providersFor("extract", { lang: "en" })[0] === "groq"
);

// ---------------------------------------------------------------------------
section("Keys belong to their provider");
// ---------------------------------------------------------------------------
check("each provider sees only its own keys", keys.usableKeys("groq").length === 1);
check("and rotation cannot stray across them", keys.nextKey("groq").provider === "groq");
check("both are configured", keys.configuredProviders().sort().join() === "gemini,groq");

keys.markExhausted(keys.nextKey("groq").id, "spent", 60);
check("a spent Groq key leaves Groq with nothing", keys.usableKeys("groq").length === 0);
check("but Gemini is unaffected", keys.usableKeys("gemini").length === 1);

const legacy = keys.listKeys().find((k) => k.key === "gem-key-0001");
check("a key with no provider recorded is treated as Gemini", legacy.provider === "gemini");

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
