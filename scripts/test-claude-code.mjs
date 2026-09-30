/**
 * Claude on the Claude plan, through Claude Code — the parts that can be
 * checked without spending the plan on it.
 *
 * What matters is what happens when the plan runs out: Claude Code answers
 * with a 429 and a sentence saying when it resets, and that has to become
 * "this model is spent until then, ask Gemini", not a failed task and not a
 * key set aside for an hour when the week has four days left to run.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-claude-code.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__claude_code__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.CORPUS_DATA_DIR = SANDBOX;
delete process.env.GEMINI_API_KEY;
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

const { parseReset, readResult } = await import("../lib/ai/claude-code.ts");
const { SubscriptionLimitError, keyFailure } = await import("../lib/ai/errors.ts");
const { PROVIDERS, PROVIDER_IDS, OFFERED_PROVIDER_IDS, modelsFor } = await import("../lib/providers.ts");
const { withRotation, providersFor } = await import("../lib/ai/client.ts");
const keys = await import("../lib/keys.ts");
const { saveConfig } = await import("../lib/config.ts");

const WEEKLY = "You've hit your weekly limit · resets Oct 4, 4pm (Africa/Cairo)";

// ---------------------------------------------------------------------------
section("When the plan comes back");
// ---------------------------------------------------------------------------
const now = new Date(2026, 8, 30, 14, 0);
check("a weekly reset names the day", parseReset(WEEKLY, now)?.getTime() === new Date(2026, 9, 4, 16, 0).getTime(), String(parseReset(WEEKLY, now)));
check("a five-hour reset later today", parseReset("resets 9:30pm", now)?.getTime() === new Date(2026, 8, 30, 21, 30).getTime());
check("or tomorrow, once the hour has passed", parseReset("resets 11am", now)?.getTime() === new Date(2026, 9, 1, 11, 0).getTime());
check("midnight is twelve am", parseReset("resets 12am", now)?.getTime() === new Date(2026, 9, 1, 0, 0).getTime());
check("January from December is next year", parseReset("resets Jan 2, 4pm", new Date(2026, 11, 30))?.getFullYear() === 2027);
check("no time given is no time", parseReset("something went wrong", now) === null);

// ---------------------------------------------------------------------------
section("What Claude Code printed");
// ---------------------------------------------------------------------------
const ok = readResult(
  JSON.stringify({
    is_error: false,
    result: '{"a":1}',
    usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 },
    modelUsage: { "claude-sonnet-5-5": {} },
  })
);
check("the answer is the result", ok.text === '{"a":1}');
check("cached input still counts as input", ok.usage.tokensIn === 105 && ok.usage.tokensOut === 7, JSON.stringify(ok.usage));
check("the exact model is reported, not the alias", ok.model === "claude-sonnet-5-5");
check(
  "structured output is kept when it comes separately",
  JSON.stringify(readResult(JSON.stringify({ is_error: false, result: "", structured_output: { b: 2 } })).structured) === '{"b":2}'
);

let limit;
try {
  readResult(JSON.stringify({ is_error: true, api_error_status: 429, result: WEEKLY }));
} catch (e) {
  limit = e;
}
check("a spent plan is a SubscriptionLimitError", limit instanceof SubscriptionLimitError, String(limit));
check("with the reset it named", limit?.resetAt instanceof Date);

let signedOut;
try {
  readResult(JSON.stringify({ is_error: true, api_error_status: 401, result: "Invalid API key · Please run /login" }));
} catch (e) {
  signedOut = e;
}
check("signed out reads as a rejected key", keyFailure(signedOut).kind === "invalid", String(signedOut));

let busy;
try {
  readResult(JSON.stringify({ is_error: true, api_error_status: 529, result: "Overloaded" }));
} catch (e) {
  busy = e;
}
check("anything else is not a limit", !(busy instanceof SubscriptionLimitError) && /529/.test(String(busy)));

// ---------------------------------------------------------------------------
section("The provider");
// ---------------------------------------------------------------------------
const p = PROVIDERS["claude-code"];
check("the app knows it", PROVIDER_IDS.includes("claude-code"));
check("it has its own adapter", p.kind === "claude-code");
check("it asks for Sonnet", modelsFor("claude-code")[0] === "claude-sonnet-5-5");
check("it takes text only", !p.capabilities.vision && !p.capabilities.audio && !p.capabilities.embed);
check("it does not claim a bill", !/\$/.test(p.freeTier));
check(
  "Settings offers the plan and not the API",
  OFFERED_PROVIDER_IDS.includes("claude-code") && !OFFERED_PROVIDER_IDS.includes("anthropic")
);

// ---------------------------------------------------------------------------
section("A spent plan moves the work, until the reset");
// ---------------------------------------------------------------------------
for (const k of keys.listKeys()) keys.removeKey(k.id);
keys.clearSpentModels();
keys.addKey("plan", "My plan", { provider: "claude-code" });
keys.addKey("gemini-key-0123456789-abcdef", "G0", { provider: "gemini" });
saveConfig({ routing: { brief: "claude-code" } });
const chain = providersFor("brief");
check("the brief goes to the plan first, Gemini behind it", chain[0] === "claude-code" && chain.includes("gemini"), chain.join(" > "));

const resetAt = new Date(Date.now() + 3 * 86_400_000);
const asked = [];
const r = await withRotation(chain, async (k, model) => {
  asked.push(`${k.provider}:${model}`);
  if (k.provider === "claude-code") throw new SubscriptionLimitError(WEEKLY, resetAt);
  return "from gemini";
});
check("Gemini answered when the plan was spent", r.value === "from gemini", asked.join(" > "));
check("the plan was asked once", asked.filter((a) => a.startsWith("claude-code")).length === 1);
check("and is set aside", keys.modelSpent("claude-code", "claude-sonnet-5-5"));
const f = keyFailure(new SubscriptionLimitError(WEEKLY, resetAt));
check("until the moment it named, not the usual hour", f.kind === "daily" && f.resetAt?.getTime() === resetAt.getTime());
// The key itself rests at most the ring's eight hours, so a plan that resets
// early (Claude Code's clock and ours can disagree) is found again the same day.
const plan = keys.listKeys().find((k) => k.provider === "claude-code");
const rest = plan?.exhaustedUntil ? new Date(plan.exhaustedUntil).getTime() - Date.now() : 0;
check("the key rests for hours, not the usual one", rest > 7 * 3_600_000 && rest <= 8 * 3_600_000 + 60_000, String(plan?.exhaustedUntil));

section("The model chosen in Settings");
{
  const { modelOfCall } = await import("../lib/ai/client.ts");
  const planKey = keys.listKeys().find((k) => k.provider === "claude-code");
  saveConfig({ claudeModel: "claude-opus-5-5" });
  check("the plan asks for the chosen model", modelOfCall(planKey, { model: "gemini-3.8-flash" }) === "claude-opus-5-5");
  saveConfig({ claudeModel: "claude-sonnet-5-5", stageModels: { brief: "claude-opus-5-5", extract: "claude-haiku-4-5" } });
  check("a stage's own Claude wins", modelOfCall(planKey, { stage: "brief" }) === "claude-opus-5-5");
  check("each stage its own", modelOfCall(planKey, { stage: "extract" }) === "claude-haiku-4-5");
  check("a stage with none uses the plan's model", modelOfCall(planKey, { stage: "entry" }) === "claude-sonnet-5-5");
  saveConfig({ stageModels: {} });
  keys.markModelSpent("claude-code", "claude-sonnet-5-5", 600);
  keys.forgetPlanLimit();
  check("signing in to another account lets go of a spent plan", !keys.modelSpent("claude-code", "claude-sonnet-5-5"));
}

keys.clearSpentModels();
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
