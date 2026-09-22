/**
 * Asking the library a vague question and getting passages, not an answer.
 *
 * The embedding call is stubbed — these check the ranking, the rare-word lift,
 * the bookkeeping of what has a vector, and above all that what comes back is
 * passages from the library with their addresses on them. No network, no key.
 *
 * The ranking rules themselves were settled by measurement on 22 September
 * 2026 (see lib/meaning-search.ts); each section below pins one of them so it
 * cannot quietly come undone.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-meaning.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__meaning__");
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
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// A stand-in for the embedding service: a vector over a small vocabulary, so
// "cost of the war" and "the war cost billions" land near each other and "a
// recipe for bread" does not. Words outside the vocabulary — a name, say —
// are invisible to it, which is what lets the rare-word lift be tested.
// ---------------------------------------------------------------------------
const VOCAB = ["war", "cost", "billion", "senate", "vote", "bread", "flour", "oven", "iran", "budget"];
const fakeVector = (text) => {
  const t = text.toLowerCase();
  const v = new Float32Array(VOCAB.length);
  VOCAB.forEach((w, i) => (v[i] = (t.match(new RegExp(w, "g")) ?? []).length));
  let norm = Math.hypot(...v);
  if (!norm) {
    v[0] = 1e-3;
    norm = 1e-3;
  }
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
};

let embedCalls = 0;
let embedTexts = [];
const embedder = async (texts) => {
  embedCalls++;
  embedTexts.push(...texts);
  return { vectors: texts.map(fakeVector) };
};

const { db } = await import("../lib/db/index.ts");
const { askLibrary, coverage, embedPassages, contentWords } = await import("../lib/meaning-search.ts");
const { isJunkText } = await import("../lib/junk-text.ts");

const addSource = (id, title, author = null) => {
  db().prepare("INSERT INTO sources (id, title, author, kind, status) VALUES (?, ?, ?, 'text', 'ready')").run(id, title, author);
  db().prepare("INSERT INTO documents (id, source_id, ordinal, label) VALUES (?, ?, 0, 'Text')").run(id, id);
};
const addChunk = (id, sourceId, seq, text) =>
  db()
    .prepare("INSERT INTO chunks (id, source_id, doc_id, seq, text, token_est, locator_json) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .run(id, sourceId, sourceId, seq, text, JSON.stringify({ page: seq + 1 }));

// ---------------------------------------------------------------------------
section("A library with passages in it — and one that is not text");
// ---------------------------------------------------------------------------
const PASSAGES = [
  "The Pentagon told Congress the war in Iran had cost 43.6 billion dollars through September.",
  "Senators pressed the budget office on what the war would cost over a full year.",
  "A recipe for bread: flour, water, salt, and a very hot oven for thirty minutes.",
  "The vote in the Senate was close, and turned on a procedural question nobody had expected.",
];
// What a PDF's compressed stream looks like when it is read as a web page.
const BYTES = "D[L�%&�DDDDDDDG <�c���4E�#��5�F DDE�B�".repeat(12);

addSource(1, "A Reporter's Notebook", "Someone");
PASSAGES.forEach((t, i) => addChunk(i + 1, 1, i, t));
addChunk(5, 1, 4, BYTES);

check("the bytes are recognised as not text", isJunkText(BYTES));
check("and prose is not mistaken for them", PASSAGES.every((p) => !isJunkText(p)));
check("nor is Arabic prose", !isJunkText("في نوفمبر سيصوت الأمريكيون على انتخاب دونالد ترامب مرة أخرى، أو هكذا يريد."));

let cov = coverage();
check("nothing is searchable by meaning yet", cov.chunks === 5 && cov.embedded === 0, JSON.stringify(cov));

const done = await embedPassages({ limit: 100, embedder });
check("indexing accounts for every passage", done === 5, String(done));
check("in one call rather than one per passage", embedCalls === 1, `${embedCalls} calls`);
check("and never sends the bytes to be embedded", !embedTexts.includes(BYTES) && embedTexts.length === 4);

cov = coverage();
check("the bytes are not counted as searchable", cov.chunks === 4 && cov.embedded === 4, JSON.stringify(cov));
check("so nothing is left for the Index button to offer", cov.chunks - cov.embedded === 0);

const again = await embedPassages({ limit: 100, embedder });
check("indexing again does nothing", again === 0 && embedCalls === 1, `${again} · ${embedCalls} calls`);

// ---------------------------------------------------------------------------
section("A vague question finds the passage, not the words");
// ---------------------------------------------------------------------------
const { results } = await askLibrary("how much has the fighting cost so far", { limit: 4, embedder });

const COST = [PASSAGES[0], PASSAGES[1]];
check(
  "the two passages about what the war cost lead",
  COST.includes(results[0]?.text) && COST.includes(results[1]?.text),
  results.map((r) => r.text.slice(0, 40)).join(" | ")
);
check("the bytes never come back", !results.some((r) => r.text === BYTES));

const first = results[0];
check("a result names its source", first.sourceTitle === "A Reporter's Notebook");
check("and its author", first.author === "Someone");
check("and where in it", first.locator.length > 0, first.locator);
check("and which passage to open", typeof first.chunkId === "number" && first.chunkId > 0);
check("and carries the passage's own words", PASSAGES.includes(first.text));
check(
  "nothing came back that is not in the library",
  results.every((r) => PASSAGES.includes(r.text)),
  "a result was not one of the stored passages"
);
check("a library of four is too small to call anything close", results.every((r) => r.strength === null));

// ---------------------------------------------------------------------------
section("Which of a question's words are worth looking up");
// ---------------------------------------------------------------------------
check(
  "function words are dropped",
  JSON.stringify(contentWords("how did the war become what it is")) === JSON.stringify(["war", "become"]),
  JSON.stringify(contentWords("how did the war become what it is"))
);
check("a figure is kept even when it is short", contentWords("the 43 billion").includes("43"));
check("Arabic function words are dropped too", !contentWords("كيف ساعد رئيس الوزراء").includes("كيف"));

// ---------------------------------------------------------------------------
section("A rare word lifts; being found by your words never sinks a passage");
// ---------------------------------------------------------------------------
// Two passages that mean the same to the stand-in embedder, one of which
// holds a name it cannot see — the way a nickname or a company name can be
// invisible to a real one. The lift is deliberately small (0.03, the value
// measured best), so it does not override meaning; what it does is decide
// between passages meaning cannot tell apart, which is exactly the case of
// two accounts of one thing where only one names the person you asked about.
addChunk(6, 1, 5, "The war cost many billions, the minister Yamani told the budget committee.");
addChunk(7, 1, 6, "The war cost many billions, the minister told the budget committee.");
await embedPassages({ limit: 100, embedder });
const { results: byName } = await askLibrary("what Yamani said the war cost", { limit: 6, embedder });
const named6 = byName.findIndex((r) => r.text.includes("Yamani"));
const twin = byName.findIndex((r) => r.text === "The war cost many billions, the minister told the budget committee.");
check(
  "between two passages meaning cannot separate, the one with your name ranks first",
  named6 >= 0 && twin >= 0 && named6 < twin,
  byName.map((r) => r.text.slice(0, 44)).join(" | ")
);
check("and says so", byName[named6]?.via === "both", byName[named6]?.via);
check(
  "while the other is still offered, found by meaning",
  byName.some((r) => r.text === "The war cost many billions, the minister told the budget committee." && r.via === "meaning")
);

// The shipped blend scored a passage found by both at 0.75·meaning + 0.25·words
// and one found by meaning alone at 0.85·meaning, so matching your word could
// push it down — "Al Smooth" went to 1,956th. Now a word can only add.
const plain = await askLibrary("war cost billion", { limit: 4, embedder });
const named = await askLibrary("war cost billion Pentagon", { limit: 4, embedder });
const at = (list) => list.results.findIndex((r) => r.text === PASSAGES[0]);
check(
  "adding a name the passage holds never moves it down",
  at(named) <= at(plain) && at(named) === 0,
  `${at(plain)} → ${at(named)}`
);
check("its score only rises", named.results[at(named)].score >= plain.results[at(plain)].score);

// ---------------------------------------------------------------------------
section("In a library big enough to judge, strength means something");
// ---------------------------------------------------------------------------
// Two hundred and forty passages of kitchen talk and one about the war: the
// war passage should stand far above the crowd for a war question, and the
// crowd should not.
addSource(2, "Kitchen Notes");
const KITCHEN = ["bread", "flour", "oven", "bread and flour", "flour in the oven", "oven bread"];
for (let i = 0; i < 240; i++) addChunk(100 + i, 2, i, `Note ${i}: more ${KITCHEN[i % KITCHEN.length]}, as usual, and a little salt.`);
await embedPassages({ limit: 500, embedder });
check("the larger library is indexed", coverage().embedded >= 244, JSON.stringify(coverage()));

const big = await askLibrary("what did the war cost", { limit: 30, embedder });
const war = big.results.find((r) => r.text === PASSAGES[0]);
check("strength is given once the library is large", big.results.every((r) => r.strength !== null));
check("the passage about the war is a close match", war?.strength === "close", String(war?.strength));
check(
  "and a note about bread is not",
  big.results.filter((r) => r.text.startsWith("Note")).every((r) => r.strength !== "close"),
  JSON.stringify(big.results.filter((r) => r.text.startsWith("Note")).slice(0, 3).map((r) => r.strength))
);

// A word most of the library holds is not rare, and lifts nothing.
const common = await askLibrary("flour", { limit: 5, embedder });
check(
  "a common word gives no lift",
  common.results.every((r) => r.via === "meaning"),
  JSON.stringify(common.results.map((r) => r.via))
);

// ---------------------------------------------------------------------------
section("The edges");
// ---------------------------------------------------------------------------
const before = embedCalls;
const empty = await askLibrary("   ", { limit: 4, embedder });
check("an empty question asks nothing", empty.results.length === 0);
check("and spends nothing", embedCalls === before, `${embedCalls} vs ${before}`);

const scoped = await askLibrary("what did the war cost", { sourceId: 999, embedder });
check("a search scoped to a source with nothing in it is empty", scoped.results.length === 0);

const inOne = await askLibrary("what did the war cost", { sourceId: 2, limit: 5, embedder });
check("a scoped search stays inside its source", inOne.results.every((r) => r.sourceId === 2));

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
