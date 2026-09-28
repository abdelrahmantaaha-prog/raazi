/**
 * Sync between two laptops.
 *
 * No network here: the peer is a snapshot file this script writes itself.
 * The properties are the ones that make a copy safe to take — the snapshot
 * is a complete library, the old one survives as a backup, the swapped-in one
 * opens through the ordinary path and its file paths point at this machine —
 * and the ones that make it honest: the fingerprint changes when you work
 * and "changed since the last sync" is true exactly then.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-sync.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_sync__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.env.CORPUS_DATA_DIR = SANDBOX;
process.env.CORPUS_WORKER_IDLE_MS = "150";

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

const { db, SOURCES_DIR } = await import("../lib/db/index.ts");
const sync = await import("../lib/sync.ts");
const Database = (await import("better-sqlite3")).default;

section("The fingerprint follows the work");
{
  const a = sync.fingerprint();
  db().prepare("INSERT INTO sources (title, kind, status) VALUES ('One', 'text', 'ready')").run();
  const b = sync.fingerprint();
  check("adding a source changes it", a.key !== b.key);
  check("it counts sources", b.sources === 1);
  const status = sync.localStatus();
  check("status says who this is", status.app === "corpus" && typeof status.host === "string");
  check("never synced means nothing has changed 'since'", status.changedSinceSync === false && status.last === null);

  sync.saveSyncSettings({ peerUrl: "http://100.1.2.3:5400/", peerToken: " abc " });
  const s = sync.syncSettings();
  check("peer settings are saved and tidied", s.peerUrl === "http://100.1.2.3:5400" && s.peerToken === "abc");
  sync.saveSyncSettings({ last: { at: new Date().toISOString(), peer: s.peerUrl, direction: "pull", fingerprint: b.key } });
  check("right after a sync nothing has changed since", sync.localStatus().changedSinceSync === false);
  db().prepare("INSERT INTO sources (title, kind, status) VALUES ('Two', 'text', 'ready')").run();
  check("working afterwards is 'changed since'", sync.localStatus().changedSinceSync === true);
}

section("Files are listed and resolved inside data/ only");
{
  fs.mkdirSync(SOURCES_DIR, { recursive: true });
  fs.writeFileSync(path.join(SOURCES_DIR, "7.pdf"), "pdf bytes");
  const files = sync.listFiles();
  check("a source file is listed with its size", files.some((f) => f.rel === "sources/7.pdf" && f.size === 9));
  check("a listed name resolves", sync.resolveFile("sources/7.pdf") === path.join(SOURCES_DIR, "7.pdf"));
  check("a path outside is refused", sync.resolveFile("../config.json") === null && sync.resolveFile("sources/../corpus.db") === null);
  check("an unknown root is refused", sync.resolveFile("backups/x.db") === null);
}

section("A snapshot is a whole library");
{
  const file = await sync.snapshot();
  check("the snapshot exists", fs.existsSync(file));
  const probe = new Database(file, { readonly: true });
  check("it carries the rows", probe.prepare("SELECT COUNT(*) AS n FROM sources").get().n === 2);
  check("it passes SQLite's check", probe.pragma("quick_check", { simple: true }) === "ok");
  probe.close();
  fs.unlinkSync(file);
}

section("Making a copy never stops the server answering");
{
  // Enough rows that the copy takes many steps: a VACUUM INTO of the live
  // library held the whole server for its length, and every window said the
  // server was down while a follower took its copy.
  db().exec("CREATE TABLE IF NOT EXISTS __ballast (x TEXT)");
  const put = db().prepare("INSERT INTO __ballast (x) VALUES (?)");
  db().transaction(() => {
    for (let i = 0; i < 3000; i++) put.run("x".repeat(2000));
  })();
  let ticks = 0;
  const every = setInterval(() => ticks++, 0);
  const file = await sync.snapshot();
  clearInterval(every);
  check("other work runs while the copy is made", ticks >= 3, `${ticks} ticks`);
  const probe = new Database(file, { readonly: true });
  check("and the copy is whole", probe.prepare("SELECT COUNT(*) AS n FROM __ballast").get().n === 3000);
  check("in one file, not a WAL pair", probe.pragma("journal_mode", { simple: true }) === "delete");
  probe.close();
  fs.unlinkSync(file);
  db().exec("DROP TABLE __ballast");
}

section("Installing a snapshot swaps the library and keeps the old one");
{
  // The "peer": a library with a different source, and a path recorded on
  // another machine.
  const peerFile = path.join(SANDBOX, "peer.db");
  const seed = await sync.snapshot();
  fs.renameSync(seed, peerFile);
  const peer = new Database(peerFile);
  peer.prepare("DELETE FROM sources").run();
  peer.prepare("INSERT INTO sources (title, kind, status, path) VALUES ('From the peer', 'pdf', 'ready', ?)").run("D:\\laptop\\data\\sources\\7.pdf");
  peer.close();

  const before = sync.fingerprint();
  const result = await sync.installSnapshot(peerFile, { quiesceMs: 2000 });
  check("the old library is backed up", result.backup !== null && fs.existsSync(result.backup));
  const backup = new Database(result.backup, { readonly: true });
  check("the backup still has the old rows", backup.prepare("SELECT COUNT(*) AS n FROM sources").get().n === 2);
  backup.close();
  check("the live library is now the peer's", db().prepare("SELECT title FROM sources").get()?.title === "From the peer");
  check("the fingerprint changed", result.fingerprint.key !== before.key);
  check("the snapshot file was consumed", !fs.existsSync(peerFile));
  const p = db().prepare("SELECT path FROM sources").get().path;
  check("file paths now point at this machine", p === path.join(SOURCES_DIR, "7.pdf"), p);
  check("the database works after the swap", db().prepare("SELECT COUNT(*) AS n FROM feeds").get().n === 0);

  let refused = null;
  const junk = path.join(SANDBOX, "junk.db");
  fs.writeFileSync(junk, "not a database");
  try {
    await sync.installSnapshot(junk, { quiesceMs: 500 });
  } catch (err) {
    refused = err;
  }
  check("a file that is not a library is refused before anything is touched", refused !== null && db().prepare("SELECT title FROM sources").get()?.title === "From the peer");
}

section("The work key ignores the queue's bookkeeping");
{
  const before = sync.fingerprint();
  db().prepare("INSERT INTO runs (kind, label, state) VALUES ('ingest', 'x', 'done')").run();
  db().prepare("UPDATE runs SET updated_at = '2999-01-01 00:00:00'").run();
  const after = sync.fingerprint();
  check("the full key notices a run moving", after.key !== before.key);
  check("the work key does not", after.workKey === before.workKey, `${before.workKey} → ${after.workKey}`);
  db().prepare("INSERT INTO sources (title, kind, status) VALUES ('Work', 'text', 'ready')").run();
  check("but it notices work", sync.fingerprint().workKey !== before.workKey);
}

const follow = await import("../lib/follow.ts");

section("A follower decides from what changed on each side");
{
  const last = { at: "2026-09-14T10:00:00Z", localKey: "L", primaryKey: "P", direction: "pull" };
  const d = (o) => follow.decide({ localKey: "L", primaryKey: "P", last, sinceLastPullMs: 10 * 60_000, returning: false, ...o });
  check("nothing changed: in step", d({}) === "in-step");
  check("only the primary changed: take a copy", d({ primaryKey: "P2" }) === "pull");
  check("but not more often than the interval while both are up", d({ primaryKey: "P2", sinceLastPullMs: 60_000 }) === "wait");
  check("unless coming back from an outage", d({ primaryKey: "P2", sinceLastPullMs: 60_000, returning: true }) === "pull");
  check("only this copy changed: send it back", d({ localKey: "L2" }) === "push");
  check("both changed: ask, never guess", d({ localKey: "L2", primaryKey: "P2" }) === "conflict");
  check("never synced and different: take a first copy", d({ last: null, primaryKey: "P2" }) === "first-sync");
  check(
    "never synced but already the same: nothing to copy",
    follow.decide({ localKey: "S", primaryKey: "S", last: null, sinceLastPullMs: null, returning: false }) === "adopt"
  );
}

section("A primary that cannot be reached is reported down");
{
  const token = "t".repeat(64);
  follow.saveFollowSettings({ primaryUrl: "http://127.0.0.1:9", primaryToken: token });
  const first = await follow.followTick();
  check("the state is offline", first.state === "offline" && first.primaryUp === false, JSON.stringify(first));
  const since = follow.followSettings().offlineSince;
  check("and when it went is remembered", typeof since === "string");
  const second = await follow.followTick();
  check("a second miss keeps the time of the first", second.state === "offline" && follow.followSettings().offlineSince === since);
  check("what a page is told carries no token", !JSON.stringify(follow.followView()).includes(token));
  follow.saveFollowSettings({ primaryUrl: "", primaryToken: "" });
  check("with nothing to follow it says so", (await follow.followTick()).state === "not-following");
}

section("A copy sent back is checked before it is installed");
{
  const { Readable } = await import("node:stream");
  const sent = await sync.snapshot();
  const peer = new Database(sent);
  peer.prepare("INSERT INTO sources (title, kind, status) VALUES ('Sent back', 'text', 'ready')").run();
  peer.close();
  const stream = () => Readable.toWeb(fs.createReadStream(sent));

  let refused = null;
  try {
    await sync.receiveSnapshot(stream(), { from: "laptop", expect: "a library that has moved on" });
  } catch (err) {
    refused = err;
  }
  check("sent against a library that moved on since, it is refused", refused instanceof sync.SyncConflictError);
  check("and nothing here is touched", !db().prepare("SELECT 1 FROM sources WHERE title = 'Sent back'").get());

  const got = await sync.receiveSnapshot(stream(), { from: "laptop", expect: sync.fingerprint().workKey });
  check("sent against the library it was taken from, it is installed", Boolean(db().prepare("SELECT 1 FROM sources WHERE title = 'Sent back'").get()));
  check("the library it replaced is kept as a backup", got.backup !== null && fs.existsSync(got.backup));
  check("and the sync is recorded", sync.syncSettings().last?.peer === "laptop");
  try {
    fs.unlinkSync(sent);
  } catch {
    /* consumed */
  }

  const size = await sync.receiveFile("sources/sent.txt", Readable.toWeb(Readable.from([Buffer.from("hello")])));
  check("a file sent is written where the listing names it", size === 5 && fs.readFileSync(path.join(SOURCES_DIR, "sent.txt"), "utf8") === "hello");
  let outside = null;
  try {
    await sync.receiveFile("../config.json", Readable.toWeb(Readable.from([Buffer.from("x")])));
  } catch (err) {
    outside = err;
  }
  check("and never outside the library's folders", outside !== null);
}

section("A primary waits for a follower that may be bringing work back");
{
  const { readStore, writeStore } = await import("../lib/config-file.ts");
  check("with no follower ever seen, there is nothing to wait for", follow.primaryWaiting().expect === false);
  writeStore({ ...readStore(), followers: { laptop: { lastSeen: new Date(Date.now() - 3 * 86_400_000).toISOString(), bringingWork: false } } });
  const before = follow.primaryWaiting();
  check("a follower seen before start-up is waited for", before.expect === true && before.checkedIn === false && before.host === "laptop");
  follow.recordCheckin({ host: "laptop", bringingWork: true });
  const coming = follow.primaryWaiting();
  check("once it checks in saying it has work, that is what the launcher sees", coming.checkedIn === true && coming.bringingWork === true);
  follow.recordCheckin({ host: "laptop", bringingWork: false });
  check("and once it has sent it, nothing more to wait for", follow.primaryWaiting().bringingWork === false);
  writeStore({ ...readStore(), followers: { old: { lastSeen: new Date(Date.now() - 90 * 86_400_000).toISOString(), bringingWork: false } } });
  check("a follower not heard from in months is not waited for", follow.primaryWaiting().followers.includes("old") === false);
}

section("A follower's copy never runs the worker");
{
  const worker = await import("../lib/worker.ts");
  // Installing a copy earlier kicked the worker on this (not yet follower)
  // library; let it stand down before asking whether a follower starts one.
  worker.stopWorker();
  for (let i = 0; i < 60 && worker.workerStatus().running; i++) await new Promise((r) => setTimeout(r, 50));
  process.env.CORPUS_FOLLOWER = "1";
  worker.kickWorker();
  await new Promise((r) => setTimeout(r, 50));
  check("kicking it does nothing on a copy", worker.workerStatus().running === false);
  check("and the copy knows it is one", follow.isFollower() === true && follow.followView().follower === true);
  delete process.env.CORPUS_FOLLOWER;
}

// Last: a failed copy holds the next one off for five minutes, which would
// refuse every copy a later section asked for.
section("A failed copy leaves nothing behind, and the next waits");
{
  const dir = path.join(SANDBOX, "sync");
  fs.mkdirSync(dir, { recursive: true });
  for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { force: true });
  const old = Date.now() - 2 * 60 * 60_000;
  for (const n of [`snapshot-${old}.db`, `snapshot-${old}.db-journal`, `incoming-${old}.db`, `received-${Date.now()}.db`]) {
    fs.writeFileSync(path.join(dir, n), "half a copy");
  }
  check("copies an earlier failure left are swept", sync.sweepStaleCopies() === 3);
  check("one still being received is not", fs.readdirSync(dir).some((n) => n.startsWith("received-")));

  const proto = Object.getPrototypeOf(db());
  const realBackup = proto.backup;
  proto.backup = async function (file) {
    fs.writeFileSync(file, "half a copy");
    throw new Error("disk full");
  };
  let first = null;
  try {
    await sync.snapshot();
  } catch (err) {
    first = err;
  }
  proto.backup = realBackup;
  check("a copy that fails says why", first?.message === "disk full", first?.message);
  check("and its half-written file is gone", !fs.readdirSync(dir).some((n) => n.startsWith("snapshot-")));
  let second = null;
  try {
    await sync.snapshot();
  } catch (err) {
    second = err;
  }
  check("the next copy is refused for a while, without trying", /last copy of this library failed/.test(second?.message ?? ""), second?.message);
}

section("A follower whose copy failed waits before asking again");
{
  const http = await import("node:http");
  let asked = 0;
  const token = "t".repeat(64);
  // A primary that answers its status and refuses the copy, as one out of room does.
  const primary = http.createServer((req, res) => {
    if (req.url.startsWith("/api/sync/status")) {
      res.setHeader("content-type", "application/json");
      const f = { ...sync.fingerprint(), workKey: "moved-on", key: "moved-on" };
      res.end(JSON.stringify({ ...sync.localStatus(), host: "office", fingerprint: f }));
    } else if (req.url.startsWith("/api/sync/snapshot")) {
      asked++;
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Not enough room for a copy of this library." }));
    } else {
      res.statusCode = 204;
      res.end();
    }
  });
  await new Promise((r) => primary.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${primary.address().port}`;
  follow.saveFollowSettings({
    primaryUrl: url,
    primaryToken: token,
    last: { at: new Date().toISOString(), localKey: sync.fingerprint().workKey, primaryKey: "before", direction: "pull" },
    pulledAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    offlineSince: null,
  });
  const first = await follow.followTick();
  check("the primary's reason reaches the follower", first.state === "error" && /Not enough room/.test(first.message), JSON.stringify(first));
  const second = await follow.followTick();
  check("the next tick does not ask again", asked === 1 && second.state === "behind" && /next try/.test(second.message), `${asked} asks, ${second.message}`);
  follow.saveFollowSettings({ primaryUrl: "", primaryToken: "" });
  await new Promise((r) => primary.close(r));
}

console.log(`\n${passed} passed, ${failed} failed`);
db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
