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
import http from "node:http";
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

const writeConfig = (broker, keys = realKeys.slice(0, 3), extra = {}) =>
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        keys: keys.map((k, i) => ({ id: `local${i}`, label: `Local ${i}`, key: k.key, provider: "gemini" })),
        ...(broker ? { broker } : {}),
        ...extra,
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
section("Telling the pool being down from the model saying no");

{
  const { brokerIsDown, brokerRetryAt } = await import("../lib/broker.ts");
  const { HttpError } = await import("../lib/ai/openai.ts");
  // The broker relays Google's answers byte for byte. A 404 is a retired
  // model name; a 5xx is Google having a bad minute. Neither is the pool.
  check("a relayed 404 is not an outage", !brokerIsDown(new HttpError(404, '{"error":{"message":"models/gemini-1.5-flash is not found","status":"NOT_FOUND"}}')));
  check("a relayed 503 is not an outage", !brokerIsDown(new HttpError(503, '{"error":{"message":"The model is overloaded.","status":"UNAVAILABLE"}}')));
  check("a 503 in the broker's own shape is", brokerIsDown(new HttpError(503, '{"error":{"message":"broker upstream unreachable","type":"broker_outage"}}')));
  check("the broker refusing this app's token is", brokerIsDown(new HttpError(401, '{"error":{"message":"bad token","type":"broker_auth"}}')));
  check("a route the broker does not have is", brokerIsDown(new HttpError(404, '{"error":{"message":"No route for /x.","type":"broker_not_found"}}')));
  check("no connection at all is", brokerIsDown(new Error("fetch failed")));
  check("a plain refusal is not", !brokerIsDown(new HttpError(429, '{"error":{"message":"rate limit"}}')));

  const at = new Date(Date.now() + 90_000).toISOString();
  check(
    "the pool's retryAt is read from the body",
    brokerRetryAt(new Error(`429 {"error":{"message":"All 3 keys are out of quota.","type":"broker_exhausted","retryAt":"${at}"}}`))?.toISOString() === at
  );
  check("and from the header the adapter copied", brokerRetryAt(new HttpError(429, "{}", undefined, at))?.toISOString() === at);
  check("and is absent when the pool said nothing", brokerRetryAt(new Error("429 nope")) === undefined);
}

section("What the pool does and does not configure");
{
  writeConfig({ url: "http://127.0.0.1:5620", token: "kb_test_token" });
  m = await fresh();
  const configured = m.keys.configuredProviders();
  check("Gemini counts as configured with the pool on", configured.includes("gemini"));
  check("Groq does not, just because the pool has a Groq door", !configured.includes("groq"), configured.join(","));
}

// ---------------------------------------------------------------------------
// The rotation itself, against a stand-in for the pool and the providers
// behind it. Every scenario below was a real failure: an oversized passage
// re-sent to three keys before the worker learned to split it, a busy minute
// on one key marking every other key invalid, a bad request walking the ring.
// ---------------------------------------------------------------------------
section("Rotation, against a stand-in provider");

/** A canned-answer server. Each request takes the next answer off the list;
 *  a null answer means hang, which is what a stalled socket looks like. */
const seen = [];
let answers = [];
const hanging = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ path: req.url, auth: req.headers.authorization ?? req.headers["x-goog-api-key"], body });
    const a = answers.shift();
    if (a === null) {
      hanging.push(res);
      return;
    }
    const [status, payload, headers = {}] = a ?? [500, { error: { message: "no answer scripted" } }];
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;
const reset = (...a) => {
  seen.length = 0;
  answers = a;
};
const chatOk = (content) => [200, { choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "stand-in-1" }];
const NO_PACE = { requestsPerMinute: 0 };

{
  // Q-01: a truncated answer through the pool is the passage's problem. No
  // key fixes it, so nothing else may be tried — the local key here is a
  // fake that would only ever be reached by the bug.
  writeConfig({ url: FAKE, token: "kb_test_token" }, [{ key: "AIza-fake-local-0000" }], NO_PACE);
  m = await fresh();
  const { TruncatedOutputError } = await import("../lib/ai/errors.ts");
  reset([200, {
    candidates: [{ content: { role: "model", parts: [{ text: '{"a":1' }] }, finishReason: "MAX_TOKENS" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1000 },
  }]);
  let err;
  try {
    await m.client.generateJson({ parts: ["x"], schema: { type: "OBJECT", properties: { a: { type: "NUMBER" } } } });
  } catch (e) {
    err = e;
  }
  check("a truncated answer through the pool is thrown as such", err instanceof TruncatedOutputError, String(err).slice(0, 120));
  check("after exactly one call", seen.length === 1, String(seen.length));
  check("the pool is not set aside for it", !m.keys.listKeys().find((k) => k.id === "broker-gemini")?.cooldownUntil);
  check("and the local key was never touched", !m.keys.listKeys().find((k) => k.id === "local0")?.calls);
}

{
  // Q-01: when the pool says every key is spent and when the first comes
  // back, that is how long it is set aside — not a flat minute — and the
  // work goes to the local key straight away.
  writeConfig({ url: FAKE, token: "kb_test_token" }, [], {
    ...NO_PACE,
    routing: { extract: "groq" },
    keys: [{ id: "groq0", label: "Groq 0", key: "gsk-local", provider: "groq", baseUrl: `${FAKE}/v1` }],
  });
  m = await fresh();
  const retryAt = new Date(Date.now() + 8_000).toISOString();
  reset(
    [429, { error: { message: "All 3 groq keys are out of quota.", type: "broker_exhausted", retryAt } }, { "x-broker-retry-at": retryAt }],
    chatOk('{"a":1}')
  );
  const res = await m.client.generateJson({ stage: "extract", parts: ["x"], schema: { type: "OBJECT", properties: { a: { type: "NUMBER" } } } });
  check("the local key answered", res.data.a === 1);
  check("in two calls", seen.length === 2, String(seen.length));
  check("the second with the local key", seen[1]?.auth === "Bearer gsk-local", seen[1]?.auth);
  const pool = m.keys.listKeys().find((k) => k.id === "broker-groq");
  const until = pool?.cooldownUntil ? new Date(pool.cooldownUntil).getTime() - Date.now() : NaN;
  check("the pool is set aside until the pool's own time, not a flat minute", until > 4_000 && until < 10_000, `${Math.round(until / 1000)}s`);
  check("the model that answered is reported", res.model === "stand-in-1", String(res.model));
}

{
  // Q-01: a bad request through the pool is thrown at once. It used to cool
  // the pool and go on to a local key, which got the same 400.
  const { HttpError } = await import("../lib/ai/openai.ts");
  writeConfig({ url: FAKE, token: "kb_test_token" }, [], {
    ...NO_PACE,
    routing: { extract: "groq" },
    keys: [{ id: "groq0", label: "Groq 0", key: "gsk-local", provider: "groq", baseUrl: `${FAKE}/v1` }],
  });
  m = await fresh();
  reset([400, { error: { message: "messages: must contain at least one user message" } }]);
  let err;
  try {
    await m.client.generateJson({ stage: "extract", parts: ["x"], schema: { type: "OBJECT", properties: {} } });
  } catch (e) {
    err = e;
  }
  check("a 400 through the pool is thrown as a 400", err instanceof HttpError && err.status === 400, String(err).slice(0, 80));
  check("after one call, not two", seen.length === 1, String(seen.length));
  check("and the local Groq key is untouched", !m.keys.listKeys().find((k) => k.id === "groq0")?.calls);
}

{
  // Q-11: the json_schema fallback fires only when that is what the endpoint
  // objects to. Any other 400 used to be re-posted, doubling its cost.
  writeConfig(null, [], {
    ...NO_PACE,
    routing: { extract: "custom" },
    keys: [{ id: "c0", label: "Custom 0", key: "ck-0", provider: "custom", baseUrl: `${FAKE}/v1` }],
  });
  m = await fresh();
  reset(
    [400, { error: { message: "response_format value as json_schema is not supported by this model" } }],
    chatOk('{"a":2}')
  );
  const res = await m.client.generateJson({ stage: "extract", parts: ["x"], schema: { type: "OBJECT", properties: { a: { type: "NUMBER" } } } });
  check("an endpoint without json_schema is retried in plain JSON mode", res.data.a === 2 && seen.length === 2);
  check("and the retry asks for json_object", /json_object/.test(seen[1]?.body ?? ""));

  reset([400, { error: { message: "context_length_exceeded" } }]);
  let err;
  try {
    await m.client.generateJson({ stage: "extract", parts: ["x"], schema: { type: "OBJECT", properties: {} } });
  } catch (e) {
    err = e;
  }
  check("any other 400 is not re-posted", seen.length === 1 && err?.status === 400, `${seen.length} calls`);
}

{
  // Q-02: two rejections on one call is one bad request, not a ring of bad
  // keys. The third key must not be tried, let alone marked.
  writeConfig(null, [], {
    ...NO_PACE,
    routing: { extract: "custom" },
    keys: ["c0", "c1", "c2"].map((id) => ({ id, label: id, key: `ck-${id}`, provider: "custom", baseUrl: `${FAKE}/v1` })),
  });
  m = await fresh();
  reset(
    [401, { error: { message: "Invalid API key" } }],
    [401, { error: { message: "Invalid API key" } }],
    [401, { error: { message: "Invalid API key" } }]
  );
  let err;
  try {
    await m.client.generateJson({ stage: "extract", parts: ["x"], schema: { type: "OBJECT", properties: {} } });
  } catch (e) {
    err = e;
  }
  check("the walk stops after two rejections", seen.length === 2, String(seen.length));
  check("the error is thrown rather than the ring being emptied", err?.status === 401, String(err).slice(0, 80));
  const ks = m.keys.listKeys();
  check("the two that were tried are marked", ks.filter((k) => k.invalid).length === 2);
  check("the third is not", !ks.find((k) => k.id === "c2")?.invalid);
}

{
  // Q-02: a pinned key does not rotate. Rate-limited, it is waited for and
  // asked again; refused over a file, the call ends there and no other key
  // is blamed for it.
  writeConfig(null, [], {
    ...NO_PACE,
    keys: ["p0", "p1"].map((id) => ({ id, label: id, key: `ck-${id}`, provider: "custom", baseUrl: `${FAKE}/v1` })),
  });
  m = await fresh();
  reset([429, { error: { message: "Rate limit reached" } }, { "retry-after": "1" }], chatOk("PINNED"));
  const t0 = Date.now();
  const res = await m.client.generateText({ parts: ["x"], pin: "p0" });
  check("a rate-limited pinned key is waited for, then answers", res.data === "PINNED");
  check("both calls went to the pinned key", seen.length === 2 && seen.every((r) => r.auth === "Bearer ck-p0"), seen.map((r) => r.auth).join(","));
  check("with the provider's own wait between them", Date.now() - t0 >= 900, `${Date.now() - t0}ms`);
  check("and the other key never saw the call", !m.keys.listKeys().find((k) => k.id === "p1")?.calls);

  reset([403, { error: { code: 403, message: "You do not have permission to access the File abc or it may not exist.", status: "PERMISSION_DENIED" } }]);
  let err;
  try {
    await m.client.generateText({ parts: ["x"], pin: "p0" });
  } catch (e) {
    err = e;
  }
  check("a file-permission 403 on the pinned key ends the call", err?.status === 403, String(err).slice(0, 60));
  check("after one attempt", seen.length === 1);
  check("and no key is marked invalid for it", m.keys.listKeys().every((k) => !k.invalid));
}

{
  // Q-06: no call runs forever. A socket that never answers used to hold
  // the single worker until someone restarted the server.
  writeConfig(null, [], {
    ...NO_PACE,
    keys: [{ id: "t0", label: "t0", key: "ck-t0", provider: "custom", baseUrl: `${FAKE}/v1` }],
  });
  m = await fresh();
  reset(null);
  const t0 = Date.now();
  let err;
  try {
    await m.client.generateText({ parts: ["x"], pin: "t0", timeoutMs: 500 });
  } catch (e) {
    err = e;
  }
  check("a call that never answers is abandoned at the timeout", err !== undefined && Date.now() - t0 < 5_000, `${Date.now() - t0}ms`);
  check("as a timeout, which the worker treats as a network blip", /timeout|abort/i.test(String(err?.name) + String(err?.message)), String(err?.name));
  for (const r of hanging) r.end();
}

await new Promise((r) => fake.close(r));

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
