/**
 * A book matched to its translation, passage by passage.
 *
 * The matcher is the one Mutarjim arrived at and this ports: rare tokens that
 * survive translation untouched — years, figures, names kept in Latin script —
 * pin a monotone skeleton, and Gale–Church fills in between them by character
 * length, producing the joins, splits and omissions a real translator makes.
 * No model reads either text, so every check here is deterministic.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-bilingual.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__bilingual__");
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
section("The matcher, on its own");
// ---------------------------------------------------------------------------
const { scriptAlign } = await import("../lib/align/script.ts");

const EN = [
  "In November 2026 Americans will vote again.",
  "The president called the midterms a referendum on his own name.",
  "Democrats were delighted by the framing and repeated it.",
  "Turnout in 2024 had been 66 percent, the highest in a century.",
  "Nobody expects that to be matched.",
];
const AR = [
  "في نوفمبر 2026 سيصوت الأمريكيون مرة أخرى.",
  "ووصف الرئيس انتخابات التجديد النصفي بأنها استفتاء على اسمه هو.",
  "وقد أسعد هذا التأطير الديمقراطيين فكرروه.",
  "وكانت نسبة المشاركة في 2024 قد بلغت ستة وستين في المئة، وهي الأعلى منذ قرن.",
  "ولا أحد يتوقع تكرار ذلك.",
];

const straight = scriptAlign(EN, AR);
check("every passage finds its partner", straight.pairs.length === 5, `${straight.pairs.length} pairs`);
check(
  "and finds the right one",
  straight.pairs.every((p) => p.s.length === 1 && p.t.length === 1 && p.s[0] === p.t[0]),
  JSON.stringify(straight.pairs.map((p) => [p.s, p.t]))
);
check("the years anchor it", straight.anchors >= 2, `${straight.anchors} anchors`);
check("and the anchored pairs are the confident ones", straight.pairs.some((p) => p.viaAnchor && p.confidence > 0.9));

// A translator who joins two sentences into one.
const joined = scriptAlign(EN, [
  AR[0],
  `${AR[1]} ${AR[2]}`,
  AR[3],
  AR[4],
]);
const merge = joined.pairs.find((p) => p.s.length === 2);
check("a join shows as two passages against one", Boolean(merge), JSON.stringify(joined.pairs.map((p) => [p.s, p.t])));
check("and the join is the right two", merge ? merge.s[0] === 1 && merge.s[1] === 2 : false);

// A translator who leaves a sentence out.
//
// A short omission is not distinguishable from a join by length alone, and
// Gale–Church prices a 2-1 bead far below a 1-0 one, so it merges — which is
// the right guess and what it does here. What must not happen either way is
// losing a passage: every one on each side has to appear exactly once.
const dropped = scriptAlign(EN, [AR[0], AR[1], AR[3], AR[4]]);
const usedS = dropped.pairs.flatMap((p) => p.s);
const usedT = dropped.pairs.flatMap((p) => p.t);
check(
  "a dropped passage costs nothing on the source side",
  usedS.length === EN.length && new Set(usedS).size === EN.length,
  JSON.stringify(dropped.pairs.map((p) => [p.s, p.t]))
);
check("and nothing is invented on the other", usedT.length === 4 && new Set(usedT).size === 4);
check("the pairs stay in order", usedS.every((v, i) => i === 0 || v > usedS[i - 1]));
check("and the years still anchor the rest", dropped.pairs.some((p) => p.viaAnchor));

// An omission the length model *can* see: a long passage with no counterpart
// of anything like its size, where merging would wreck the ratio. The matcher
// leaves such a passage out of its result entirely — which is why
// alignTranslation walks both index spaces rather than the pairs alone.
const LONG = "A long digression on the history of turnout, running for several sentences and covering " +
  "every midterm since the war, with figures for each and a note on the weather in each November, " +
  "which the translator of this edition chose to leave out of the Arabic altogether.";
const withGap = scriptAlign([EN[0], LONG, EN[4]], [AR[0], AR[4]]);
check(
  "a passage with no counterpart is simply absent from the matcher's pairs",
  !withGap.pairs.some((p) => p.s.includes(1)),
  JSON.stringify(withGap.pairs.map((p) => [p.s, p.t]))
);

check("two empty texts do not throw", scriptAlign([], []).pairs.length === 0);
check("a book with no translation yields nothing", scriptAlign(EN, []).pairs.every((p) => p.t.length === 0));

// ---------------------------------------------------------------------------
section("Pairing two sources in the library");
// ---------------------------------------------------------------------------
const { db } = await import("../lib/db/index.ts");
const { alignTranslation, translationsOf, originalOf, alignedPairs, unlinkTranslation } = await import(
  "../lib/translations.ts"
);

const addSource = (id, title, lang) => {
  db().prepare("INSERT INTO sources (id, title, kind, status, lang) VALUES (?, ?, 'text', 'ready', ?)").run(id, title, lang);
  db().prepare("INSERT INTO documents (id, source_id, ordinal, label) VALUES (?, ?, 0, 'Text')").run(id, id);
};
const addChunks = (sourceId, texts) => {
  const ins = db().prepare(
    "INSERT INTO chunks (source_id, doc_id, seq, text, token_est, locator_json) VALUES (?, ?, ?, ?, 0, ?)"
  );
  texts.forEach((t, i) => ins.run(sourceId, sourceId, i, t, JSON.stringify({ chapter: "One" })));
};

addSource(601, "The Midterms", "en");
addSource(602, "انتخابات التجديد النصفي", "ar");
addChunks(601, EN);
addChunks(602, AR);

const result = alignTranslation(601, 602);
check("the pairing reports what it matched", result.pairs === 5, JSON.stringify(result));
check("and that the whole book found a partner", result.covered === 1, String(result.covered));

const list = translationsOf(601);
check("the book now lists its translation", list.length === 1 && list[0].id === 602);
check("with its coverage", Math.round(list[0].covered * 100) === 100, String(list[0].covered));
check("and the translation knows its original", originalOf(602)?.id === 601);
check("while the original is nobody's translation", originalOf(601) === null);

const pairs = alignedPairs(601, 602);
check("the reader gets a row per matched passage", pairs.length === 5);
check("each row carries the text of both sides", pairs.every((p) => p.original[0]?.text && p.translation[0]?.text));
check("in reading order", pairs.every((p, i) => p.seq === i));
check("the first row is the first passage of each", pairs[0].original[0].text === EN[0] && pairs[0].translation[0].text === AR[0]);
check("and the locator comes with it", pairs[0].original[0].locator === "One");

// Matching again replaces rather than doubles.
alignTranslation(601, 602);
check("matching again does not double the rows", alignedPairs(601, 602).length === 5);

// A translation that leaves a passage out: the book still reads whole, with
// the gap showing, rather than the passage vanishing from the page.
addSource(604, "A partial rendering", "ar");
addChunks(604, [AR[0], AR[4]]);
addSource(605, "The Midterms, longer", "en");
addChunks(605, [EN[0], LONG, EN[4]]);
alignTranslation(605, 604);
const partial = alignedPairs(605, 604);
const everyOriginal = partial.flatMap((p) => p.original.map((c) => c.text));
check(
  "every passage of the book is still on the page",
  everyOriginal.length === 3 && everyOriginal.includes(LONG),
  JSON.stringify(partial.map((p) => [p.original.length, p.translation.length]))
);
check(
  "and the one with no counterpart has an empty side",
  partial.some((p) => p.original.some((c) => c.text === LONG) && p.translation.length === 0)
);
check("which is marked as unmatched", partial.some((p) => p.via === "unmatched"));
check(
  "nothing of the translation is lost either",
  partial.flatMap((p) => p.translation).length === 2
);
check("and the rows stay in reading order", partial.every((p, i) => p.seq === i));
check(
  "coverage reports the shortfall",
  Math.round((translationsOf(605)[0]?.covered ?? 0) * 100) < 100,
  String(translationsOf(605)[0]?.covered)
);

unlinkTranslation(602);
check("unpairing forgets the rows", alignedPairs(601, 602).length === 0);
check("and the link", originalOf(602) === null && translationsOf(601).length === 0);

// Guards.
let threw = null;
try {
  alignTranslation(601, 601);
} catch (e) {
  threw = e.message;
}
check("a book cannot be its own translation", Boolean(threw), String(threw));

addSource(603, "Nothing read in yet", "en");
threw = null;
try {
  alignTranslation(601, 603);
} catch (e) {
  threw = e.message;
}
check("and one with no passages says so rather than matching nothing", Boolean(threw), String(threw));

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
