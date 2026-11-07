/**
 * Finding the book's paragraphs on the PDF's pages — the page view's matching.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-pdf-align.mjs
 */
const { fold, bookText, align, findSelection, tidySelection } = await import("../lib/pdf-align.ts");

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
section("Folding keeps only what both sides agree on");
// ---------------------------------------------------------------------------
check("spaces, punctuation and case go", fold("The State, again.").text === "thestateagain");
check("a hyphen at a line break mends", fold("exam-\nple").text === fold("example").text);
check("Arabic presentation forms become letters", fold("ﺍﻟﺪﻭﻟﺔ").text === fold("الدولة").text);
check("hamza on alef, ta marbuta and alef maqsura are one form", fold("أحمد إلى مدرسة").text === fold("احمد الي مدرسه").text);
check("diacritics and tatweel go", fold("الْعَـرَبِيَّة").text === fold("العربيه").text);
check("Arabic-Indic digits are digits", fold("١٩٤٨").text === "1948");
const f = fold("A, b");
check("each folded character knows where it came from", f.map.join(",") === "0,3");

// ---------------------------------------------------------------------------
section("Paragraphs are found on their pages");
// ---------------------------------------------------------------------------
const pages = [
  ["CONTENTS", "Chapter One The Long Road 3", "Chapter Two Arrival 9"],
  ["Chapter One", "The Long Road", "It was a long road from the coast to the capital, and the", "travellers took", "three weeks over it."],
  ["THE LONG ROAD 4", "When they came to the river they found the bridge gone, wash-", "ed away in the spring floods."],
  ["Chapter Two", "Arrival", "The capital was smaller than any of them had imagined."],
];
const book = bookText(pages);
const paragraphs = [
  { text: "Chapter One", page: 2, until: 4 },
  { text: "The Long Road", page: 2, until: 4 },
  { text: "It was a long road from the coast to the capital, and the travellers took three weeks over it.", page: 2, until: 4 },
  { text: "When they came to the river they found the bridge gone, washed away in the spring floods.", page: 2, until: 4 },
  { text: "Chapter Two", page: 4, until: null },
  { text: "Arrival", page: 4, until: null },
  { text: "The capital was smaller than any of them had imagined.", page: 4, until: null },
];
const parts = align(book, paragraphs);
check("every paragraph is found", parts.every(Boolean), JSON.stringify(parts));
check("a chapter title is found in the chapter, not the contents", parts[0]?.[0].page === 1, JSON.stringify(parts[0]));
check("the second title too", parts[4]?.[0].page === 3, JSON.stringify(parts[4]));
check("a paragraph broken across runs covers them all", parts[2]?.[0].from === 2 && parts[2]?.[0].to === 4, JSON.stringify(parts[2]));
check("past a running head on the next page", parts[3]?.[0].page === 2 && parts[3]?.[0].from === 1, JSON.stringify(parts[3]));

// A paragraph that runs over a page break is found on both.
const spanning = bookText([["The first half of a sentence that"], ["FOLIO 2", "runs on to the next page and ends there."]]);
const across = align(spanning, [{ text: "The first half of a sentence that runs on to the next page and ends there.", page: 1 }])[0];
check("a paragraph across a page break has a part on each page", across?.length === 2 && across[0].page === 0 && across[1].page === 1, JSON.stringify(across));

// Passages in another order from the pages still find their own.
const shuffled = align(book, [paragraphs[6], paragraphs[2]]);
check("passages out of page order are each found on their pages", shuffled[0]?.[0].page === 3 && shuffled[1]?.[0].page === 1, JSON.stringify(shuffled));

// A book whose passages name printed folios, some pages behind the file's own.
const offsetBook = bookText([
  ["Cover"],
  ["Copyright"],
  ["An opening paragraph long enough to be unmistakable anywhere in the book."],
  ["A second paragraph, which follows on the next page of the file itself."],
]);
const offset = align(offsetBook, [
  { text: "An opening paragraph long enough to be unmistakable anywhere in the book.", page: 1, until: 2 },
  { text: "A second paragraph, which follows on the next page of the file itself.", page: 2, until: null },
]);
check("pages named off by an offset are still found", offset[0]?.[0].page === 2 && offset[1]?.[0].page === 3, JSON.stringify(offset));

check("text that is not in the PDF is not found", align(book, [{ text: "Nothing like this sentence appears anywhere in it.", page: 2 }])[0] === null);

// ---------------------------------------------------------------------------
section("A selection on the page comes back as the extracted words");
// ---------------------------------------------------------------------------
const extracted = [
  "It was a long road from the coast to the capital, and the travellers took three weeks over it.",
  "When they came to the river they found the bridge gone, washed away in the spring floods.",
];
const sel = findSelection("from the coast to the capital, and the\ntravellers took\nthree weeks over it.", extracted);
check("lines joined as the extraction has them", sel?.text === "from the coast to the capital, and the travellers took three weeks over it.", sel?.text);
check("and in the paragraph it began in", sel?.paragraph === 0);
const sel2 = findSelection("bridge gone, wash-\ned away", extracted);
check("a word broken at the line end comes back whole", sel2?.text === "bridge gone, washed away", sel2?.text);
check("a selection spanning two paragraphs keeps both", findSelection("three weeks over it.\nWhen they came", extracted)?.text === "three weeks over it.\n\nWhen they came");
check("a selection that is not there is not invented", findSelection("an entirely different sentence", extracted) === null);
check("tidied when it cannot be found", tidySelection("a broken wo-\nrd and\nanother line") === "a broken word and another line");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
