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
  const file = sync.snapshot();
  check("the snapshot exists", fs.existsSync(file));
  const probe = new Database(file, { readonly: true });
  check("it carries the rows", probe.prepare("SELECT COUNT(*) AS n FROM sources").get().n === 2);
  check("it passes SQLite's check", probe.pragma("quick_check", { simple: true }) === "ok");
  probe.close();
  fs.unlinkSync(file);
}

section("Installing a snapshot swaps the library and keeps the old one");
{
  // The "peer": a library with a different source, and a path recorded on
  // another machine.
  const peerFile = path.join(SANDBOX, "peer.db");
  const seed = sync.snapshot();
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

console.log(`\n${passed} passed, ${failed} failed`);
db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
