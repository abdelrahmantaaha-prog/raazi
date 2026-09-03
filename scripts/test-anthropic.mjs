/**
 * The Anthropic adapter's pure parts — everything that can be checked without
 * spending a token.
 *
 * Three things about this API are easy to get wrong and expensive to discover
 * at run time: it rejects `temperature` outright, its model ids take no date
 * suffix, and `effort` is the dial that replaced sampling. All three are
 * checked here rather than in a failing run at two in the morning.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-anthropic.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

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

const { EFFORT, checkStop } = await import("../lib/ai/anthropic.ts");
const { toJsonSchema, dropNulls } = await import("../lib/ai/schema.ts");
const { TruncatedOutputError, SafetyBlockError } = await import("../lib/ai/errors.ts");
const { PROVIDERS, STAGES } = await import("../lib/providers.ts");

// ---------------------------------------------------------------------------
section("A Gemini schema reaches Claude unchanged");
// ---------------------------------------------------------------------------
// The adapter hands output_config.format the same translation the OpenAI path
// uses, so a handler writes its schema once and any provider can answer it.
const gemini = {
  type: "OBJECT",
  properties: {
    surface: { type: "STRING" },
    kind: { type: "STRING", enum: ["person", "org", "place"] },
    claim: { type: "STRING", description: "Optional." },
    dates: { type: "ARRAY", items: { type: "STRING" } },
    source: {
      type: "OBJECT",
      properties: { title: { type: "STRING" }, page: { type: "INTEGER" } },
      required: ["title"],
    },
  },
  required: ["surface", "kind"],
};

const js = toJsonSchema(gemini);
check("the object type is lowercased", js.type === "object", String(js.type));
check("so are the leaf types", js.properties.surface.type === "string");
check("enums survive", JSON.stringify(js.properties.kind.enum) === '["person","org","place"]');
check("array items are translated too", js.properties.dates.items.type === "string");
check(
  "nested objects recurse — and are nullable when optional, like any other field",
  JSON.stringify(js.properties.source.type) === '["object","null"]',
  JSON.stringify(js.properties.source.type)
);
check(
  "integers survive as integers, down inside them",
  JSON.stringify(js.properties.source.properties.page.type) === '["integer","null"]',
  JSON.stringify(js.properties.source.properties.page.type)
);
check(
  "an optional field becomes nullable rather than absent",
  JSON.stringify(js.properties.claim.type) === '["string","null"]',
  JSON.stringify(js.properties.claim.type)
);
check("every property is required, as strict mode wants", js.required.length === 5, JSON.stringify(js.required));
check("and no extra ones are allowed", js.additionalProperties === false);
check("nested objects are strict too", js.properties.source.additionalProperties === false);
check(
  "the translation is JSON-serialisable, which is all the API sees",
  JSON.parse(JSON.stringify(js)).properties.kind.enum.length === 3
);

// The round trip the adapter actually performs: schema out, answer back in.
// The nullable fields above mean a well-behaved model may return nulls, and
// handlers expect the key to be missing instead.
const answered = dropNulls({
  surface: "Gamal Abdel Nasser",
  kind: "person",
  claim: null,
  dates: ["1918", null],
  source: { title: "The Struggle", page: null },
});
check("nulls are stripped before a handler sees them", !("claim" in answered));
check("including inside nested objects", !("page" in answered.source));
check("and inside arrays", answered.dates.length === 1, JSON.stringify(answered.dates));
check("while real values are untouched", answered.surface === "Gamal Abdel Nasser");

// ---------------------------------------------------------------------------
section("Stop reasons map onto the app's own vocabulary");
// ---------------------------------------------------------------------------
const threw = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
};

check("a finished answer is not an error", threw(() => checkStop("end_turn")) === null);
check("and neither is a missing stop reason", threw(() => checkStop(undefined)) === null);
check("nor a null one", threw(() => checkStop(null)) === null);
check("nor a stop sequence", threw(() => checkStop("stop_sequence")) === null);

const cut = threw(() => checkStop("max_tokens"));
check("a truncated answer is a TruncatedOutputError", cut instanceof TruncatedOutputError, String(cut));

// Claude's refusals arrive as a 200, not an error status — read the stop
// reason or the worker records a mangled answer as a real one.
const refused = threw(() => checkStop("refusal", { category: "violence" }));
check("a refusal is a safety block", refused instanceof SafetyBlockError, String(refused));
check("and carries the category through", /violence/.test(refused.message), refused.message);
const bare = threw(() => checkStop("refusal"));
check("a refusal with no detail still blocks", bare instanceof SafetyBlockError);
check("saying only that it was refused", /refusal/.test(bare.message), bare.message);

// ---------------------------------------------------------------------------
section("Effort is set everywhere, because it replaced temperature");
// ---------------------------------------------------------------------------
const LEVELS = ["low", "medium", "high", "xhigh", "max"];
for (const stage of STAGES) {
  check(`${stage} has an effort`, LEVELS.includes(EFFORT[stage]), String(EFFORT[stage]));
}
check("context does too, though it is not routable on its own", LEVELS.includes(EFFORT.context));
check("mechanical reading is cheap", EFFORT.extract === "low" && EFFORT.tag === "low");
check("writing and answering are not", EFFORT.entry === "high" && EFFORT.ask === "high");
check("an unknown stage falls through to the adapter's default", EFFORT[""] === undefined);

// ---------------------------------------------------------------------------
section("The three facts that produce a 400 if forgotten");
// ---------------------------------------------------------------------------
const adapter = fs.readFileSync(path.join(root, "lib", "ai", "anthropic.ts"), "utf8");
const client = fs.readFileSync(path.join(root, "lib", "ai", "client.ts"), "utf8");

// A sampling parameter is a hard 400 on every current Claude model, and every
// caller in this app passes one — so the whole point of the adapter is that it
// stops there.
check(
  "the adapter never sends a sampling parameter",
  !/\b(temperature|top_p|top_k)\s*:/.test(adapter)
);

/** The body of each `kind === "anthropic"` branch in the client. */
function anthropicBranches(src) {
  const out = [];
  const marker = /kind === "anthropic"\)\s*\{/g;
  for (let m; (m = marker.exec(src)); ) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

/** The comments explain why temperature is absent, so they are not evidence. */
const code = (s) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const branches = anthropicBranches(client).map(code);
check("the client routes to Claude in three places", branches.length === 3, String(branches.length));
for (const [i, body] of branches.entries()) {
  check(
    `branch ${i + 1} forwards no temperature`,
    !/\btemperature\b/.test(body),
    body.slice(0, 120)
  );
}
const calls = branches.filter((b) => /anthropic(Json|Text)[<(]/.test(b));
check("two of them are the generate paths", calls.length === 2, String(calls.length));
for (const [i, body] of calls.entries()) {
  check(`generate path ${i + 1} passes the stage's effort`, /effort:\s*EFFORT\[/.test(body));
  check(`generate path ${i + 1} passes the computed timeout`, /timeoutMs,/.test(body));
  check(`generate path ${i + 1} passes the key's base URL`, /baseUrl:\s*k\.baseUrl/.test(body));
}

// Structured output is output_config.format on this API — not a response
// schema, and not a tool call dressed up as one.
check(
  "structured output goes through output_config.format",
  /output_config:\s*\{[\s\S]*?format:\s*\{\s*type:\s*"json_schema"/.test(adapter)
);
check("and effort rides in the same object", /output_config:\s*\{\s*\n?\s*effort:/.test(adapter));

// A date suffix on a model id is a 404, and the ids below are the whole set.
const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
check(
  "the default model is one of the three real ids",
  MODELS.includes(PROVIDERS.anthropic.defaultModel),
  PROVIDERS.anthropic.defaultModel
);
const named = adapter.match(/"claude-[a-z0-9.-]+"/g) ?? [];
check(
  "and every model the adapter names is too",
  named.every((m) => MODELS.includes(m.slice(1, -1))),
  named.join(", ")
);

// ---------------------------------------------------------------------------
section("What Settings promises about it");
// ---------------------------------------------------------------------------
const p = PROVIDERS.anthropic;
check("it takes its own request shape", p.kind === "anthropic");
check("it can read images", p.capabilities.vision === true);
check("it produces JSON to a schema", p.capabilities.json === true);
check("it cannot transcribe", p.capabilities.audio === false);
check("and has no embeddings endpoint", p.capabilities.embed === false);
check("a second key buys nothing — one account, one bill", p.keysMultiply === false);
check("the base URL is left to the SDK", p.baseUrl === "");
check("the key page is linked", /console\.anthropic\.com/.test(p.keysUrl));
check("the price is stated, not implied", /\$/.test(p.freeTier) && /paid only/i.test(p.freeTier));

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
