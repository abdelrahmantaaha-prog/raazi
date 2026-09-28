/**
 * The Library's word counts, measured once per source and remembered.
 *
 * On 28 September the Library asked for every source's word count every 1.5
 * seconds while the worker ran, and each ask measured the text of the whole
 * library — about a second from a cold disk, on the thread that answers every
 * window. With the machine short of memory that was a cold disk every time,
 * and the windows put up "The Corpus server is down". wordsBySource() measures
 * a source once and again only when its chunks change.
 *
 * Runs against a scratch database. No API key needed.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-words.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__words__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.CORPUS_DATA_DIR = SANDBOX;

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`);
  }
};

const { db } = await import("../lib/db/index.ts");
const { wordsBySource } = await import("../lib/queries.ts");

const addSource = (id) => {
  db().prepare("INSERT INTO sources (id, title, kind, status) VALUES (?, ?, 'text', 'ready')").run(id, `Source ${id}`);
  db().prepare("INSERT INTO documents (id, source_id, ordinal, label) VALUES (?, ?, 0, 'Text')").run(id, id);
};
const addChunks = (sourceId, texts, from = 0) => {
  const ins = db().prepare(
    "INSERT INTO chunks (source_id, doc_id, seq, text, token_est, locator_json) VALUES (?, ?, ?, ?, 0, '{}')"
  );
  texts.forEach((t, i) => ins.run(sourceId, sourceId, from + i, t));
};
/** What the Library used to compute on every ask. */
const measured = (id) =>
  db().prepare("SELECT COALESCE(SUM(LENGTH(text)), 0) / 6 AS w FROM chunks WHERE source_id=?").get(id).w;

// Measures are counted by wrapping the one statement that reads the text.
let reads = 0;
const realPrepare = db().prepare.bind(db());
db().prepare = (sql) => {
  const stmt = realPrepare(sql);
  if (!/SUM\(LENGTH\(text\)\)/.test(sql)) return stmt;
  const get = stmt.get.bind(stmt);
  stmt.get = (...a) => {
    reads++;
    return get(...a);
  };
  return stmt;
};

addSource(1);
addSource(2);
addSource(3);
addChunks(1, ["a".repeat(600), "b".repeat(1200)]);
addChunks(2, ["مرحبا بالعالم ".repeat(50)]);

// The reference measure above reads the text too, so each count is taken
// straight after the call it belongs to.
let words = wordsBySource();
let n = reads;
check("an English source counts as before", words.get(1) === measured(1), `${words.get(1)} vs ${measured(1)}`);
check("so does an Arabic one", words.get(2) === measured(2), `${words.get(2)} vs ${measured(2)}`);
check("a source with no chunks is simply absent", !words.has(3));
check("each source was measured once", n === 2, `${n} reads`);

reads = 0;
words = wordsBySource();
n = reads;
check("asking again measures nothing", n === 0, `${n} reads`);
check("and gives the same counts", words.get(1) === measured(1) && words.get(2) === measured(2));

reads = 0;
addChunks(1, ["c".repeat(3000)], 2);
words = wordsBySource();
n = reads;
check("a source that gained a chunk is measured again", words.get(1) === measured(1), `${words.get(1)} vs ${measured(1)}`);
check("and only that one", n === 1, `${n} reads`);

reads = 0;
// Re-chunking replaces rows: the same number of chunks, but new ids.
db().prepare("DELETE FROM chunks WHERE source_id=2").run();
addChunks(2, ["x".repeat(60)]);
words = wordsBySource();
n = reads;
check("a re-chunked source with the same chunk count is measured again", words.get(2) === 10, String(words.get(2)));
check("once", n === 1, `${n} reads`);

db().prepare("DELETE FROM chunks WHERE source_id=2").run();
words = wordsBySource();
check("a source whose chunks are gone drops out", !words.has(2));
check("and is forgotten", !globalThis.__corpusWords.has(2));

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
