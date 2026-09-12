/**
 * Which model a call asks a key for, and what "out of quota for the day"
 * means about each. No network — nothing here calls a provider.
 *
 * Ported from Mutarjim, which met the failure this guards against: a daily
 * refusal used to retire whatever model the RING would have chosen for the
 * key, regardless of which model the call had actually asked for — and only
 * when that model was in the ring. A refusal on a model outside it (the
 * embedding model here) was charged to the key instead, the rotation moved
 * to the next key, that one met the same wall, and one refused call set
 * aside every key on the ring for an hour.
 *
 *   npx tsx scripts/test-rotation.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__rotation__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.CORPUS_DATA_DIR = SANDBOX;
delete process.env.GEMINI_API_KEY;
// The pacer would otherwise sleep between attempts on the same key.
fs.writeFileSync(path.join(SANDBOX, "config.json"), JSON.stringify({ requestsPerMinute: 0, model: "" }));

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

const { modelOfCall } = await import("../lib/ai/client.ts");
const keys = await import("../lib/keys.ts");
const { MODEL_RING } = await import("../lib/providers.ts");
const { ModelExhaustedError, classify, noFreeTierQuota } = await import("../lib/ai/errors.ts");
const { getConfig } = await import("../lib/config.ts");

const RING = MODEL_RING.gemini;
/** A model a caller might ask for by name. Deliberately outside the ring. */
const LITE = "gemini-flash-lite-latest";
const EMBED = getConfig().embedModel;

function reset() {
  for (const k of keys.listKeys()) keys.removeKey(k.id);
  keys.clearSpentModels();
  return keys.addKey("key-value-0123456789-abcdef", "K0");
}

// ---------------------------------------------------------------------------
section("The model a call asks for is the model that gets blamed");
// ---------------------------------------------------------------------------
{
  const key = reset();
  check("a call with no preference gets the head of the ring", modelOfCall(key, {}) === RING[0], modelOfCall(key, {}));
  check("a preference is honoured while its allowance lasts", modelOfCall(key, { model: LITE }) === LITE);

  // This is what the rotation now does on a daily refusal: retire the model
  // that ANSWERED. Nothing else is touched.
  keys.markModelSpent("gemini", LITE, 60);
  check("retiring the preferred model leaves the ring alone", RING.every((m) => !keys.modelSpent("gemini", m)));
  check("and the key is untouched", keys.usableKeys("gemini").length === 1);
  check(
    "the next call falls through to the ring rather than failing",
    modelOfCall(key, { model: LITE }) === RING[0],
    modelOfCall(key, { model: LITE })
  );
}

// ---------------------------------------------------------------------------
section("The ring still steps down model by model");
// ---------------------------------------------------------------------------
{
  const key = reset();
  keys.markModelSpent("gemini", RING[0], 60);
  check("a spent ring model steps aside for the next one down", modelOfCall(key, {}) === RING[1]);
  check("a preference for a spent ring model does the same", modelOfCall(key, { model: RING[0] }) === RING[1]);
  keys.markModelSpent("gemini", RING[1], 60);
  check("and again", modelOfCall(key, {}) === RING[2]);
  for (const m of RING) keys.markModelSpent("gemini", m, 60);
  check(
    "with the whole ring spent the head is asked again — nothing left is not the same as nothing",
    modelOfCall(key, {}) === RING[0]
  );
}

// ---------------------------------------------------------------------------
section("A key pinned to its own model still wins");
// ---------------------------------------------------------------------------
{
  reset();
  const pinned = keys.addKey("another-key-0123456789-abcdef", "K1", { model: "gemini-3.5-flash" });
  const key = keys.listKeys().find((k) => k.id === pinned.id);
  check("a key that names its own model is not overruled by the ring", modelOfCall(key, {}) === "gemini-3.5-flash");
  const claude = keys.addKey("sk-ant-0123456789-abcdefghij", "claude", { provider: "anthropic", model: "claude-opus-5" });
  const ck = keys.listKeys().find((k) => k.id === claude.id);
  check("on Claude too, over a caller's preference", modelOfCall(ck, { model: "claude-sonnet-5" }) === "claude-opus-5");
}

// ---------------------------------------------------------------------------
section("Providers that do not meter per model take the caller's word");
// ---------------------------------------------------------------------------
{
  reset();
  const local = keys.addKey("ollama-any-text-works-here", "local", { provider: "ollama" });
  const lk = keys.listKeys().find((k) => k.id === local.id);
  check("this machine answers with the model it is asked for", modelOfCall(lk, { model: "qwen3.5:9b" }) === "qwen3.5:9b");
  check("or its default when nothing is named", modelOfCall(lk, {}) === MODEL_RING.ollama[0]);
  const claude = keys.addKey("sk-ant-0123456789-abcdefghij", "claude", { provider: "anthropic" });
  const ck = keys.listKeys().find((k) => k.id === claude.id);
  check("and Claude with its default", modelOfCall(ck, {}).startsWith("claude-"));
}

// ---------------------------------------------------------------------------
section("The embedding model is a hard pin, and its quota is its own problem");
// ---------------------------------------------------------------------------
// embed() passes `modelOf: () => cfg.embedModel, hardPin: true` rather than
// going through modelOfCall, precisely so a spent embedding model is never
// swapped for a text model that cannot embed — and so its refusal stops at
// the model rather than walking the ring.
{
  const key = reset();
  keys.markModelSpent("gemini", EMBED, 60);
  const substitute = modelOfCall(key, { model: EMBED });
  check(
    "modelOfCall would substitute a text model, which is why embed() must not use it",
    substitute !== EMBED && RING.includes(substitute),
    substitute
  );
  check("the text ring is untouched by the embedding model's refusal", RING.every((m) => !keys.modelSpent("gemini", m)));
  check("and so is the key", keys.usableKeys("gemini").length === 1);

  const refusal = (limit) =>
    new Error(
      'got status: 429 {"error":{"code":429,"message":"You exceeded your current quota. ' +
        `* Quota exceeded for metric: generate_content_free_tier_requests, limit: ${limit}` +
        '","status":"RESOURCE_EXHAUSTED"}}'
    );
  check("a limit of 0 is an allowance that does not exist", noFreeTierQuota(refusal(0)));
  check("a limit of 100 is one that has been spent", !noFreeTierQuota(refusal(100)));

  const absent = new ModelExhaustedError(EMBED, new Date(Date.now() + 3600e3), "spent", true);
  const spent = new ModelExhaustedError(EMBED, new Date(Date.now() + 3600e3), "spent", false);
  check("nothing to wait for is settled, not parked", classify(absent, 1).kind === "skip");
  const parked = classify(spent, 1);
  check("a spent allowance parks and comes back", parked.kind === "pause_quota");
  check(
    "for the hour the ring gives a model, not until midnight",
    parked.kind === "pause_quota" && parked.resumeAt.getTime() - Date.now() < 2 * 3600e3
  );
  check("both name the model and say the keys are fine", /keys themselves are fine/.test(absent.message) && absent.message.includes(EMBED));
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
