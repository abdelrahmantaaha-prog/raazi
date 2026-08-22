/**
 * The shared key pool, and the promise that made it safe to adopt: if the
 * broker is unreachable, the keys on this machine still answer.
 *
 * The first half is offline. The second half makes two real calls — one through
 * the broker, one with the broker pointed at a dead port — because "falls back
 * to local keys" is not a thing you can assert against a mock.
 *
 *   npx tsx scripts/test-broker.mjs
 *
 * Skips the live half if no broker is configured in data/config.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__broker__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.CORPUS_DATA_DIR = SANDBOX;
delete process.env.GEMINI_API_KEY;
delete process.env.BROKER_URL;
delete process.env.BROKER_TOKEN;

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

/** The real settings, so the live half talks to the broker actually in use. */
const realConfig = JSON.parse(
  fs.readFileSync(path.join(root, "data", "config.json"), "utf8")
);
const realKeys = (realConfig.keys ?? []).filter((k) => (k.provider ?? "gemini") === "gemini");
const configPath = path.join(SANDBOX, "config.json");

/** Quota is counted per model, and the everyday one is usually the spent one by
 *  evening — so the live calls use the lite model, whose allowance is its own. */
const LIVE_MODEL = "gemini-flash-lite-latest";

const writeConfig = (broker, keys = realKeys.slice(0, 3)) =>
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        keys: keys.map((k, i) => ({ id: `local${i}`, label: `Local ${i}`, key: k.key, provider: "gemini" })),
        ...(broker ? { broker } : {}),
      },
      null,
      2
    )
  );

const fresh = async () => {
  // The ring re-reads its file on every call, so a new config is picked up
  // straight away. The broker's cooldowns are in memory and process-wide, which
  // is right in production and wrong between two cases here — hence the clear.
  const broker = await import("../lib/broker.ts");
  broker.clearBrokerState();
  const bust = `?t=${Date.now()}${Math.random()}`;
  return {
    keys: await import(`../lib/keys.ts${bust}`),
    client: await import(`../lib/ai/client.ts${bust}`),
  };
};

// ---------------------------------------------------------------------------
section("The pool joins the ring");

writeConfig({ url: "http://127.0.0.1:5620", token: "kb_test_token" });
let m = await fresh();
let listed = m.keys.listKeys();

check("the pool is listed before this machine's own keys", listed[0]?.id === "broker-gemini",
  listed.map((k) => k.id).join(","));
check("both surfaces are offered", listed.some((k) => k.id === "broker-groq"));
check("the pool key carries a base URL", listed[0]?.baseUrl === "http://127.0.0.1:5620/gemini",
  String(listed[0]?.baseUrl));
check("local keys are still there behind it", listed.filter((k) => k.id.startsWith("local")).length === 3);
check("the pool is what a call reaches for first", m.keys.nextKey("gemini")?.id === "broker-gemini");

section("The pool is not a key you own");

m.keys.markExhausted("broker-gemini", "pretend quota", 60);
const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
check("its cooldown is never written to config.json",
  !JSON.stringify(onDisk.keys).includes("broker"),
  JSON.stringify(onDisk.keys?.map((k) => k.id)));
check("but it is respected while the process lives",
  m.keys.nextKey("gemini")?.id === "local0",
  m.keys.nextKey("gemini")?.id);
check("local keys were left alone", onDisk.keys.length === 3);

section("Turning it off");

writeConfig({ url: "http://127.0.0.1:5620", token: "kb_test_token", enabled: false });
m = await fresh();
check("enabled:false takes it off the ring", !m.keys.listKeys().some((k) => k.id.startsWith("broker-")));

writeConfig(null);
m = await fresh();
check("no settings, no pool", m.keys.listKeys().every((k) => k.id.startsWith("local")));

// ---------------------------------------------------------------------------
const live = realConfig.broker?.url && realConfig.broker?.token;
if (!live) {
  console.log("\n(no broker in data/config.json — skipping the live half)");
} else {
  section("A real call through the pool");

  writeConfig(realConfig.broker);
  m = await fresh();
  try {
    const res = await m.client.generateText({
      parts: ["Reply with exactly: BROKER"],
      model: LIVE_MODEL,
      temperature: 0,
    });
    check("it answers", res.data.includes("BROKER"), res.data.slice(0, 80));
    const used = m.keys.listKeys().find((k) => k.id === "broker-gemini");
    check("and the pool is what answered", (used?.calls ?? 0) > 0, `calls=${used?.calls}`);
    check("no local key was touched",
      m.keys.listKeys().filter((k) => k.id.startsWith("local")).every((k) => !k.calls));
  } catch (err) {
    check("it answers", false, String(err).slice(0, 200));
  }

  section("With the pool unreachable");

  // Port 1 is nothing at all, which is what a broker outage looks like here.
  writeConfig({ url: "http://127.0.0.1:1", token: realConfig.broker.token });
  m = await fresh();
  try {
    const res = await m.client.generateText({
      parts: ["Reply with exactly: LOCAL"],
      model: LIVE_MODEL,
      temperature: 0,
    });
    check("this machine's own keys pick the work up", res.data.includes("LOCAL"), res.data.slice(0, 80));
    const usedLocal = m.keys.listKeys().filter((k) => k.id.startsWith("local") && k.calls);
    check("and one of them is what answered", usedLocal.length === 1, usedLocal.map((k) => k.id).join(","));
    const pool = m.keys.listKeys().find((k) => k.id === "broker-gemini");
    check("the pool is set aside, not written off", Boolean(pool?.cooldownUntil) && !pool?.invalid);
  } catch (err) {
    check("this machine's own keys pick the work up", false, String(err).slice(0, 200));
  }
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
