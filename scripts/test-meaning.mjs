/**
 * Asking the library a vague question and getting passages, not an answer.
 *
 * The embedding call is stubbed — these check the ranking, the blending with
 * word matching, the bookkeeping of what has a vector, and above all that what
 * comes back is passages from the library with their addresses on them. No
 * network, no key.
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
// A stand-in for the embedding service.
//
// Each text becomes a vector over a small vocabulary — so "cost of the war"
// and "the war cost billions" land near each other and "a recipe for bread"
// does not. Crude, and enough to prove the ranking does what it claims.
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
let embedTexts = 0;
// Passed in rather than patched over the module: lib/meaning-search takes an
// embedder so the ranking can be tested without a network or a key.
const embedder = async (texts) => {
  embedCalls++;
  embedTexts += texts.length;
  return { vectors: texts.map(fakeVector) };
};

const { db } = await import("../lib/db/index.ts");
const { askLibrary, coverage, embedPassages } = await import("../lib/meaning-search.ts");

// ---------------------------------------------------------------------------
section("A library with passages in it");
// ---------------------------------------------------------------------------
const PASSAGES = [
  "The Pentagon told Congress the war in Iran had cost 43.6 billion dollars through September.",
  "Senators pressed the budget office on what the war would cost over a full year.",
  "A recipe for bread: flour, water, salt, and a very hot oven for thirty minutes.",
  "The vote in the Senate was close, and turned on a procedural question nobody had expected.",
];

db().prepare("INSERT INTO sources (id, title, author, kind, status) VALUES (1, 'A Reporter''s Notebook', 'Someone', 'text', 'ready')").run();
db().prepare("INSERT INTO documents (id, source_id, ordinal, label) VALUES (1, 1, 0, 'Text')").run();
const ins = db().prepare(
  "INSERT INTO chunks (id, source_id, doc_id, seq, text, token_est, locator_json) VALUES (?, 1, 1, ?, ?, 0, ?)"
);
PASSAGES.forEach((t, i) => ins.run(i + 1, i, t, JSON.stringify({ page: i + 1 })));

let cov = coverage();
check("nothing is searchable by meaning yet", cov.chunks === 4 && cov.embedded === 0, JSON.stringify(cov));

const done = await embedPassages({ limit: 100, embedder });
check("indexing gives every passage a vector", done === 4, String(done));
check("in one call rather than one per passage", embedCalls === 1, `${embedCalls} calls for ${embedTexts} texts`);

cov = coverage();
check("and the count says so", cov.embedded === 4 && cov.stale === 0, JSON.stringify(cov));

const again = await embedPassages({ limit: 100, embedder });
check("indexing again does nothing", again === 0, String(again));

// ---------------------------------------------------------------------------
section("A vague question finds the passage, not the words");
// ---------------------------------------------------------------------------
const { results } = await askLibrary("how much has the fighting cost so far", { limit: 4, embedder });

check("passages come back", results.length > 0, String(results.length));
// The question shares no distinctive word with either passage about what the
// war cost — "fighting" is in neither — and both still come first. That is
// the whole point of the mode.
const COST = [0, 1].map((i) => PASSAGES[i]);
check(
  "the two passages about what the war cost lead",
  COST.includes(results[0]?.text) && COST.includes(results[1]?.text),
  results.map((r) => r.text.slice(0, 40)).join(" | ")
);
check(
  "the bread recipe is not among them",
  !results.some((r) => r.text.includes("bread")),
  results.map((r) => r.text.slice(0, 30)).join(" | ")
);
check(
  "and neither is the one about procedure",
  !results.some((r) => r.text.includes("procedural")),
  results.map((r) => r.text.slice(0, 30)).join(" | ")
);

// What a result IS: an address into the library.
const first = results[0];
check("a result names its source", first.sourceTitle === "A Reporter's Notebook");
check("and its author", first.author === "Someone");
check("and where in it", first.locator.length > 0, first.locator);
check("and which passage to open", typeof first.chunkId === "number" && first.chunkId > 0);
check("and carries the passage's own words", PASSAGES.includes(first.text));
check("with a score that is only a ranking", first.score > 0 && first.score <= 1, String(first.score));

// Nothing is generated: every returned text must be verbatim from the library.
check(
  "nothing came back that is not in the library",
  results.every((r) => PASSAGES.includes(r.text)),
  "a result was not one of the stored passages"
);

// ---------------------------------------------------------------------------
section("Words still count for a name or a figure");
// ---------------------------------------------------------------------------
const { results: byName } = await askLibrary("Senate", { limit: 4, embedder });
check("a plain name still finds its passages", byName.length > 0);
check(
  "and the blend says how it was found",
  byName.every((r) => ["meaning", "words", "both"].includes(r.via)),
  JSON.stringify(byName.map((r) => r.via))
);

// ---------------------------------------------------------------------------
section("The edges");
// ---------------------------------------------------------------------------
const empty = await askLibrary("   ", { limit: 4, embedder });
check("an empty question asks nothing", empty.results.length === 0);

const callsBefore = embedCalls;
await askLibrary("   ", { embedder });
check("and spends nothing", embedCalls === callsBefore, `${embedCalls} vs ${callsBefore}`);

const nonsense = await askLibrary("zzzz qqqq xxxx", { limit: 4, embedder });
check("a question about nothing returns few or none", nonsense.results.length <= 4, String(nonsense.results.length));

const scoped = await askLibrary("what did the war cost", { sourceId: 999, embedder });
check("a search scoped to a source with nothing in it is empty", scoped.results.length === 0);

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
