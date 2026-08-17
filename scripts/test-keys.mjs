/**
 * The key ring. The behaviour worth protecting: one key running out of daily
 * quota must not stop a run — the work moves to the next key — and when every
 * key is spent the run waits only until the FIRST one comes back.
 *
 *   npx tsx scripts/test-keys.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__keys__");
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
const { keyFailure, classify, AllKeysExhaustedError, NoUsableKeysError } =
  await import("../lib/ai/errors.ts");

const quota429 = (scope) =>
  new Error(
    `429 ${JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaId: `GenerateRequests${scope}PerProjectPerModel-FreeTier` }],
          },
          ...(scope === "PerMinute"
            ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "20s" }]
            : []),
        ],
      },
    })}`
  );

// ---------------------------------------------------------------------------
section("Reading one key's failure");
// ---------------------------------------------------------------------------
check("a per-day 429 means that key is done for the day", keyFailure(quota429("PerDay")).kind === "daily");

// The case that was costing whole keys: a 429 carrying no quota metadata at
// all. Assuming the worst parked a key for eighteen hours over a burst.
const bare = new Error("429 Too Many Requests");
check("a bare 429 is assumed to be a short window, not a spent day", keyFailure(bare).kind === "rate", keyFailure(bare).kind);
check("and waits about a minute", keyFailure(bare).delayMs <= 60_000, String(keyFailure(bare).delayMs));
const rate = keyFailure(quota429("PerMinute"));
check("a per-minute 429 is only a cooldown", rate.kind === "rate", rate.kind);
check("and it carries Google's own delay", rate.delayMs === 20000, String(rate.delayMs));
check("a 401 means the key is bad", keyFailure(new Error("401 API key not valid")).kind === "invalid");
check("a 503 is nothing to do with the key", keyFailure(new Error("503 Service Unavailable")).kind === "other");

// ---------------------------------------------------------------------------
section("Holding several keys");
// ---------------------------------------------------------------------------
const a = keys.addKey("AIza-aaaaaaaaaaaa1111", "First");
const b = keys.addKey("AIza-bbbbbbbbbbbb2222", "Second");
const c = keys.addKey("AIza-cccccccccccc3333", "Third");

check("all three are on the ring", keys.listKeys().length === 3);
check("all three are usable", keys.usableKeys().length === 3);
check("adding the same key twice does not duplicate it", keys.addKey("AIza-aaaaaaaaaaaa1111").id === a.id);
check("the ring is used in order", keys.nextKey().id === a.id);
check("keys are never exposed with their value", !JSON.stringify(keys.publicKeys()).includes("aaaaaaaaaaaa"));
check("only the last four characters are shown", keys.publicKeys()[0].hint === "…1111", keys.publicKeys()[0].hint);

// ---------------------------------------------------------------------------
section("A key running out steps aside");
// ---------------------------------------------------------------------------
keys.markExhausted(a.id, "Quota refused.", 60);

check("the spent key is no longer offered", keys.nextKey().id === b.id, keys.nextKey()?.label);
check("but it is still on the ring, waiting", keys.liveKeys().length === 3);
check("its status says so", keys.publicKeys().find((k) => k.id === a.id).status === "waiting");
check("two keys remain usable", keys.usableKeys().length === 2);

keys.markInvalid(b.id, "Rejected.");
check("a rejected key is skipped too", keys.nextKey().id === c.id);
check("and is not counted as merely waiting", keys.liveKeys().length === 2);

// A short cooldown behaves differently from a spent day.
keys.markCooldown(c.id, 20_000, "Rate limited.");
check("a cooling-down key is skipped for now", keys.nextKey() === undefined);

// ---------------------------------------------------------------------------
section("When everything is spent");
// ---------------------------------------------------------------------------
const soonest = keys.earliestReset();
check("the ring reports when the first key returns", soonest !== undefined);
check(
  "and it is the 20-second cooldown, not the hour-long quota wait",
  soonest.getTime() < Date.now() + 60_000,
  soonest?.toLocaleString()
);

const exhausted = new AllKeysExhaustedError(soonest, 2);
const d = classify(exhausted, 1);
check("the worker parks the run on quota", d.kind === "pause_quota", d.kind);
check("and wakes when the first key is back, not the last", d.resumeAt.getTime() === soonest.getTime());

const rejected = classify(new NoUsableKeysError("All keys were rejected."), 1);
check("every key being rejected is a key problem, not a quota one", rejected.kind === "pause_key");

// ---------------------------------------------------------------------------
section("A refused key is not written off for the day");
// ---------------------------------------------------------------------------
const w = keys.addKey("AIza-wwwwwwwwwwww4444", "Fourth");
keys.markExhausted(w.id, "Quota refused.", 60);
const firstWait = new Date(keys.listKeys().find((k) => k.id === w.id).exhaustedUntil);
check(
  "the first refusal costs an hour, not the rest of the day",
  firstWait.getTime() <= Date.now() + 61 * 60_000,
  firstWait.toLocaleString()
);
check("and it says so", /an hour/.test(keys.publicKeys().find((k) => k.id === w.id).lastError));

keys.markExhausted(w.id, "Quota refused.", 60);
const secondWait = new Date(keys.listKeys().find((k) => k.id === w.id).exhaustedUntil);
check(
  "being refused again on the way back doubles the wait",
  secondWait.getTime() > Date.now() + 110 * 60_000,
  secondWait.toLocaleString()
);

keys.markExhausted(w.id, "Quota refused.", 60);
keys.markExhausted(w.id, "Quota refused.", 60);
keys.markExhausted(w.id, "Quota refused.", 60);
keys.markExhausted(w.id, "Quota refused.", 60);
const capped = new Date(keys.listKeys().find((k) => k.id === w.id).exhaustedUntil);
check(
  "but it never waits longer than eight hours",
  capped.getTime() <= Date.now() + 8 * 60 * 60_000 + 60_000,
  capped.toLocaleString()
);

// One call getting through means whatever was wrong has passed.
keys.reviveKey(w.id);
keys.markUsed(w.id, 10, 5);
keys.markExhausted(w.id, "Quota refused.", 60);
const afterSuccess = new Date(keys.listKeys().find((k) => k.id === w.id).exhaustedUntil);
check(
  "a successful call resets the escalation to one hour",
  afterSuccess.getTime() <= Date.now() + 61 * 60_000,
  afterSuccess.toLocaleString()
);
keys.removeKey(w.id);

// ---------------------------------------------------------------------------
section("Repeated rate limits back off too");
// ---------------------------------------------------------------------------
// A real per-minute limit clears on the first retry. A key that is actually
// spent but says only "429" would otherwise ask to be retried every minute all
// night, once per key.
const cd = keys.addKey("AIza-cdcdcdcdcdcd5555", "Fifth");
keys.markCooldown(cd.id, 60_000, "Rate limited.");
const c1 = new Date(keys.listKeys().find((k) => k.id === cd.id).cooldownUntil);
check("the first wait is the one the provider asked for", c1.getTime() <= Date.now() + 61_000);

keys.markCooldown(cd.id, 60_000, "Rate limited.");
keys.markCooldown(cd.id, 60_000, "Rate limited.");
const c3 = new Date(keys.listKeys().find((k) => k.id === cd.id).cooldownUntil);
check(
  "refusing again lengthens it rather than polling every minute",
  c3.getTime() > Date.now() + 3 * 60_000,
  c3.toLocaleTimeString()
);

for (let i = 0; i < 10; i++) keys.markCooldown(cd.id, 60_000, "Rate limited.");
const cCap = new Date(keys.listKeys().find((k) => k.id === cd.id).cooldownUntil);
check(
  "but never beyond half an hour — this is still a passing window",
  cCap.getTime() <= Date.now() + 31 * 60_000,
  cCap.toLocaleTimeString()
);

keys.markUsed(cd.id, 1, 1);
keys.markCooldown(cd.id, 60_000, "Rate limited.");
const cReset = new Date(keys.listKeys().find((k) => k.id === cd.id).cooldownUntil);
check(
  "one call getting through puts it back to a minute",
  cReset.getTime() <= Date.now() + 61_000,
  cReset.toLocaleTimeString()
);
keys.removeKey(cd.id);

// ---------------------------------------------------------------------------
section("Recovering");
// ---------------------------------------------------------------------------
keys.reviveKey(b.id);
check("retrying a rejected key puts it back", keys.nextKey()?.id === b.id, keys.nextKey()?.label);
check("and clears the error against it", !keys.publicKeys().find((k) => k.id === b.id).lastError);

keys.setKey(c.id, { disabled: true });
check("a paused key is set aside", keys.publicKeys().find((k) => k.id === c.id).status === "off");
check("and is not counted as live", keys.liveKeys().length === 2);

keys.markUsed(b.id, 1000, 500);
const used = keys.publicKeys().find((k) => k.id === b.id);
check("usage is tracked per key", used.calls === 1 && used.tokens === 1500, `${used.calls} / ${used.tokens}`);

keys.removeKey(a.id);
check("a removed key is gone", keys.listKeys().length === 2);

// ---------------------------------------------------------------------------
section("Upgrading a config from before the ring existed");
// ---------------------------------------------------------------------------
fs.writeFileSync(
  path.join(SANDBOX, "config.json"),
  JSON.stringify({ apiKey: "AIza-legacy-key-9999", model: "gemini-flash-latest" }),
  "utf8"
);
const migrated = keys.listKeys();
check("the old single key becomes the first key on the ring", migrated.length === 1, String(migrated.length));
check("with its value intact", migrated[0].key === "AIza-legacy-key-9999");
check("other settings survive the upgrade",
  JSON.parse(fs.readFileSync(path.join(SANDBOX, "config.json"), "utf8")).model === "gemini-flash-latest");
check("and the legacy field is cleared, so it cannot come back",
  JSON.parse(fs.readFileSync(path.join(SANDBOX, "config.json"), "utf8")).apiKey === undefined);

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
