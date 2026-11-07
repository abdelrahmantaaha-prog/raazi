/**
 * Pulling everything from the other laptop: every discipline and the settings.
 *
 * No network: the peer is a folder this script fills itself, and fetch is
 * answered from it the way the peer's /api/sync routes would answer. What is
 * checked is what makes a pull of everything right — disciplines meet their
 * namesakes by id whichever is open, one missing here is added, each library
 * is backed up and its file paths point at this machine, the keys and the
 * settings come across while this machine keeps its own door, and a library
 * that moved on since its last sync is not replaced without being asked.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-sync-all.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_sync_all__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
const HERE = path.join(SANDBOX, "here");
const PEER = path.join(SANDBOX, "peer");
fs.mkdirSync(HERE, { recursive: true });
process.env.CORPUS_ROOT_DIR = HERE;
// A follower's copy never runs the worker: nothing here reads, polls or spends.
process.env.CORPUS_FOLLOWER = "1";

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
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const writeJson = (f, o) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(o, null, 2));
};

const disciplines = await import("../lib/disciplines.ts");
const { db } = await import("../lib/db/index.ts");
const sync = await import("../lib/sync.ts");
const Database = (await import("better-sqlite3")).default;

const titles = (file) => {
  const d = new Database(file, { readonly: true });
  try {
    return d.prepare("SELECT title FROM sources ORDER BY id").all().map((r) => r.title);
  } finally {
    d.close();
  }
};

// --- This machine: Politics open, a Biology of its own, its own keys and door.
db().prepare("INSERT INTO sources (title, kind, status) VALUES ('Here main', 'text', 'ready')").run();
disciplines.addDiscipline("Biology");
const hereBio = path.join(HERE, "disciplines", "biology", "corpus.db");
fs.copyFileSync(await sync.snapshot(), hereBio);
{
  const d = new Database(hereBio);
  d.prepare("DELETE FROM sources").run();
  d.prepare("INSERT INTO sources (title, kind, status) VALUES ('Here bio', 'text', 'ready')").run();
  d.close();
}
writeJson(path.join(HERE, "shared.json"), {
  keys: [
    { id: "l1", label: "only here", key: "LOCALKEY", provider: "gemini" },
    { id: "l2", label: "both", key: "PEERKEY", provider: "gemini" },
  ],
  lan: { enabled: true, token: "LOCALTOKEN" },
  researchKeys: { opensky: "S-HERE" },
});
writeJson(path.join(HERE, "config.json"), {
  morningHour: 7,
  sync: { peerUrl: "http://peer:5400", peerToken: "PEERTOKEN" },
});

// --- The peer: main, biology and a network this machine has never seen.
const template = await sync.snapshot();
const peerLib = (dir, rows, files = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "corpus.db");
  fs.copyFileSync(template, file);
  const d = new Database(file);
  d.prepare("DELETE FROM sources").run();
  for (const [title, name] of rows) {
    d.prepare("INSERT INTO sources (title, kind, status, path, added_at) VALUES (?, 'text', 'ready', ?, '2026-01-02 03:04:05')").run(
      title,
      name ? `C:\\Users\\peer\\corpus\\data\\sources\\${name}` : null
    );
  }
  d.close();
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
};
peerLib(PEER, [["Peer main", "1.md"]], { "sources/1.md": "main source", "covers/1.jpg": "cover" });
peerLib(path.join(PEER, "disciplines", "biology"), [["Peer bio", null]]);
peerLib(path.join(PEER, "disciplines", "network"), [["Peer net", "7.md"]], { "sources/7.md": "net source" });
fs.unlinkSync(template);

const peerRegistry = [
  { id: "main", name: "Politics", dir: null, createdAt: "" },
  { id: "biology", name: "Biology", dir: "disciplines\\biology", createdAt: "2026-09-22T19:18:35.862Z" },
  { id: "network", name: "Network", dir: "disciplines\\network", createdAt: "2026-10-03T20:03:54.244Z" },
];
const peerDir = (id) => {
  const d = peerRegistry.find((x) => x.id === id);
  return d.dir ? path.join(PEER, ...d.dir.split("\\")) : PEER;
};
const peerShared = {
  keys: [{ id: "p1", label: "from the peer", key: "PEERKEY", provider: "gemini", calls: 42 }],
  routing: { write: "claude-code" },
  claudeModel: "claude-opus-5-5",
  researchKeys: { occrp: "O-PEER" },
  lan: { enabled: true, token: "PEERS-OWN-TOKEN" },
  followers: { laptop: { at: "x" } },
};
const peerConfigs = {
  main: { morningHour: 9, dailyBrief: false },
  biology: { morningHour: 5 },
  network: { feedPolling: false },
};

const peerFingerprint = (id) => {
  const d = new Database(path.join(peerDir(id), "corpus.db"), { readonly: true });
  try {
    return sync.fingerprint(d);
  } finally {
    d.close();
  }
};
const listing = (id) => {
  const out = [];
  for (const name of ["sources", "covers", "portraits"]) {
    const dir = path.join(peerDir(id), name);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) out.push({ rel: `${name}/${f}`, size: fs.statSync(path.join(dir, f)).size });
  }
  return out;
};

let everythingAnswers = 200;
const asked = [];
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const id = url.searchParams.get("discipline") ?? "main";
  asked.push(`${url.pathname}${url.search}`);
  const json = (o, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  switch (url.pathname) {
    case "/api/sync/status":
      return json({ app: "corpus", host: "peer-laptop", fingerprint: peerFingerprint("main") });
    case "/api/sync/everything":
      if (everythingAnswers !== 200) return json({ error: "not here" }, everythingAnswers);
      return json({
        disciplines: peerRegistry.map((d) => ({ ...d, active: d.id === "main", fingerprint: peerFingerprint(d.id).key })),
        shared: Object.fromEntries(Object.entries(peerShared).filter(([k]) => k !== "lan" && k !== "followers")),
        configs: peerConfigs,
      });
    case "/api/sync/snapshot":
      return new Response(fs.readFileSync(path.join(peerDir(id), "corpus.db")));
    case "/api/sync/files":
      return json({ files: listing(id) });
    case "/api/sync/file":
      return new Response(fs.readFileSync(path.join(peerDir(id), url.searchParams.get("path"))));
  }
  return json({ error: "no such route" }, 404);
};
const peer = { url: "http://peer:5400", token: "PEERTOKEN" };

section("An older peer is told apart, not half-copied");
{
  everythingAnswers = 404;
  let err = null;
  try {
    await sync.pullEverything(peer);
  } catch (e) {
    err = e;
  }
  check("refused with a reason", /older Raazi/.test(err?.message ?? ""), err?.message);
  check("nothing here was touched", titles(path.join(HERE, "corpus.db")).join() === "Here main");
  everythingAnswers = 200;
}

section("The first pull takes everything");
let first;
{
  first = await sync.pullEverything(peer);
  const reg = disciplines.listDisciplines();
  check("every discipline is registered", reg.map((d) => d.id).join() === "main,biology,network", reg.map((d) => d.id).join());
  check("the open one takes the peer's name", reg.find((d) => d.id === "main").name === "Politics");
  check("the open one stays open", disciplines.activeDiscipline().id === "main");

  check("the open library is the peer's", db().prepare("SELECT title FROM sources").all().map((r) => r.title).join() === "Peer main");
  const p = db().prepare("SELECT path FROM sources").get().path;
  check("its file path points here", p === path.join(HERE, "sources", "1.md"), p);
  check("its source file came", fs.readFileSync(path.join(HERE, "sources", "1.md"), "utf8") === "main source");
  check("its cover came", fs.existsSync(path.join(HERE, "covers", "1.jpg")));
  check("the open library was backed up", first.backup && titles(first.backup).join() === "Here main", first.backup);

  check("Biology here is the peer's Biology", titles(hereBio).join() === "Peer bio");
  const bioBackups = fs.readdirSync(path.join(HERE, "disciplines", "biology", "backups"));
  check(
    "and the one it replaced is kept",
    bioBackups.length === 1 && titles(path.join(HERE, "disciplines", "biology", "backups", bioBackups[0])).join() === "Here bio"
  );

  const net = path.join(HERE, "disciplines", "network");
  check("Network, new here, has its library", titles(path.join(net, "corpus.db")).join() === "Peer net");
  check("and its source file", fs.readFileSync(path.join(net, "sources", "7.md"), "utf8") === "net source");
  {
    const d = new Database(path.join(net, "corpus.db"), { readonly: true });
    const np = d.prepare("SELECT path FROM sources").get().path;
    d.close();
    check("with its path pointing at its own folder", np === path.join(net, "sources", "7.md"), np);
  }

  check(
    "the result names what happened",
    first.disciplines.map((d) => `${d.name}:${d.outcome}`).join() === "Politics:copied,Biology:copied,Network:copied",
    JSON.stringify(first.disciplines)
  );
  check("and that the settings came", first.settings === true);
  check("files are counted", first.filesCopied === 3, String(first.filesCopied));
}

section("Settings and keys come across; this machine keeps its door");
{
  const shared = readJson(path.join(HERE, "shared.json"));
  const keys = shared.keys.map((k) => k.key);
  check("the peer's key is here", keys.includes("PEERKEY"));
  check("once, with the peer's record of it", keys.filter((k) => k === "PEERKEY").length === 1 && shared.keys[0].calls === 42);
  check("a key only this machine had is kept", keys.includes("LOCALKEY"));
  check("which model does which job came", shared.routing?.write === "claude-code" && shared.claudeModel === "claude-opus-5-5");
  check("research keys from both", shared.researchKeys?.occrp === "O-PEER" && shared.researchKeys?.opensky === "S-HERE");
  check("this machine's LAN token is its own", shared.lan?.token === "LOCALTOKEN");
  check("the peer's pairings did not come", shared.followers === undefined);

  const main = readJson(path.join(HERE, "config.json"));
  check("the open discipline's settings came", main.morningHour === 9 && main.dailyBrief === false);
  check("its saved peer is still this machine's", main.sync?.peerUrl === "http://peer:5400" && main.sync?.peerToken === "PEERTOKEN");
  check("and the sync is recorded", main.sync?.last?.direction === "pull");

  const bio = readJson(path.join(HERE, "disciplines", "biology", "config.json"));
  check("Biology's settings came", bio.morningHour === 5);
  check("and its own sync record", typeof bio.sync?.last?.fingerprint === "string");
  const net = readJson(path.join(HERE, "disciplines", "network", "config.json"));
  check("Network's settings came", net.feedPolling === false);
}

section("Pulling again changes nothing");
{
  const again = await sync.pullEverything(peer);
  check(
    "every library is already the same",
    again.disciplines.every((d) => d.outcome === "same"),
    JSON.stringify(again.disciplines)
  );
  check("no file is copied twice", again.filesCopied === 0, String(again.filesCopied));
}

section("A discipline that moved on here is not replaced unasked");
{
  const d = new Database(hereBio);
  d.prepare("INSERT INTO sources (title, kind, status) VALUES ('Written here since', 'text', 'ready')").run();
  d.close();
  // and the peer's moved on too, so there is something to copy
  const p = new Database(path.join(peerDir("biology"), "corpus.db"));
  p.prepare("INSERT INTO sources (title, kind, status, added_at) VALUES ('Peer bio 2', 'text', 'ready', '2026-01-03 00:00:00')").run();
  p.close();
  let err = null;
  try {
    await sync.pullEverything(peer);
  } catch (e) {
    err = e;
  }
  check("refused, naming it", /Biology has changed since the last sync/.test(err?.message ?? ""), err?.message);
  check("and left alone", titles(hereBio).includes("Written here since"));
  const forced = await sync.pullEverything(peer, { force: true });
  check("asked, it goes ahead", titles(hereBio).join() === "Peer bio,Peer bio 2");
  check("only that one is copied", forced.disciplines.filter((x) => x.outcome === "copied").map((x) => x.name).join() === "Biology");
}

section("Serving: what this machine sends a peer");
{
  const all = sync.everything();
  check("every discipline, with a fingerprint", all.disciplines.length === 3 && all.disciplines.every((d) => d.fingerprint));
  check("the open one is marked", all.disciplines.find((d) => d.active)?.id === "main");
  check("the keys are sent", all.shared.keys?.some((k) => k.key === "LOCALKEY"));
  check("the LAN token is not", all.shared.lan === undefined && JSON.stringify(all).indexOf("LOCALTOKEN") === -1);
  check("nor a discipline's sync record", Object.values(all.configs).every((c) => c.sync === undefined));
  check("nor the saved peer's token", JSON.stringify(all).indexOf("PEERTOKEN") === -1);

  const snap = await sync.snapshot("network");
  check("another discipline's library can be copied", titles(snap).join() === "Peer net");
  fs.unlinkSync(snap);
  check("its files are listed", sync.listFiles("network").some((f) => f.rel === "sources/7.md"));
  check("and served", sync.resolveFile("sources/7.md", "network") === path.join(HERE, "disciplines", "network", "sources", "7.md"));
  check("but nothing outside them", sync.resolveFile("sources/..", "network") === null && sync.resolveFile("x/7.md", "network") === null);
  check("an unknown discipline lists nothing", sync.listFiles("nope").length === 0 && sync.resolveFile("sources/7.md", "nope") === null);
  let err = null;
  try {
    await sync.snapshot("nope");
  } catch (e) {
    err = e;
  }
  check("and is not copied", /no such discipline/.test(err?.message ?? ""), err?.message);
}

db().close();
globalThis.__corpusDb = undefined;
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
