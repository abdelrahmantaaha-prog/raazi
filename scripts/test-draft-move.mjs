/**
 * A citation survives being moved, and an Arabic draft exports right to left.
 *
 * Both reported on 20 September 2026. Moving a paragraph up or down is cut and
 * paste, and the paste handler took the clipboard's plain text — so every
 * citation marker in the moved text became the four characters "[3]": no
 * longer renumbered, no longer removed with its reference, and exported as
 * literal text rather than a footnote. And Word infers nothing about
 * direction from the characters themselves, so a draft written in Arabic came
 * out ragged-left with the footnote marks on the wrong side.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-draft-move.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__draft_move__");
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
section("A moved paragraph keeps its citations");
// ---------------------------------------------------------------------------
const { sanitizeDraftHtml, citationMarker, renumberHtml } = await import("../app/write/citations.ts");

const marker = citationMarker(42, 2);
check("a marker survives the round trip", sanitizeDraftHtml(marker).includes('data-cite="42"'));
check("and keeps its index", sanitizeDraftHtml(marker).includes('data-note="2"'));
check("and stays uneditable", sanitizeDraftHtml(marker).includes('contenteditable="false"'));

const moved = sanitizeDraftHtml(`<p>A sentence ${marker} and more.</p>`);
check("the paragraph around it survives", moved.startsWith("<p>") && moved.includes("and more."));
check(
  "and the marker is still a marker, not the text [3]",
  /<span data-cite="42"/.test(moved) && !/^\[3\]$/.test(moved),
  moved
);

// The whole point: after a move the marker still renumbers.
const afterDelete = renumberHtml(moved, [{ id: 7 }, { id: 42 }]);
check("a moved marker still renumbers", afterDelete.includes('data-note="1"') && afterDelete.includes("[2]"), afterDelete);
const orphaned = renumberHtml(moved, [{ id: 7 }]);
check("and is still removed when its reference goes", !orphaned.includes("data-cite"), orphaned);

// What must NOT come back.
const dirty =
  '<p style="color:red" class="x"><font face="Arial">Word</font> ' +
  '<span style="background:yellow">highlighted</span> <b>bold</b> <i>it</i></p>' +
  '<div onclick="alert(1)">block</div><script>alert(2)</script>';
const clean = sanitizeDraftHtml(dirty);
check("styles are dropped", !clean.includes("style=") || !clean.includes("color:red"), clean);
check("classes are dropped", !clean.includes("class="), clean);
check("a font tag is dropped but its words stay", !clean.includes("<font") && clean.includes("Word"), clean);
check("a non-marker span is dropped", !clean.includes("<span"), clean);
check("its words are kept", clean.includes("highlighted"), clean);
check("bold and italic are kept", clean.includes("<b>") && clean.includes("<i>"), clean);
check("a script tag cannot come through", !clean.includes("<script"), clean);
check("nor an event handler", !clean.includes("onclick"), clean);
check("a div is dropped but its words stay", !clean.includes("<div") && clean.includes("block"), clean);

const structure = sanitizeDraftHtml("<h2>Head</h2><blockquote>Quoted</blockquote><ul><li>One</li></ul>");
check(
  "headings, quotes and lists are kept",
  structure.includes("<h2>") && structure.includes("<blockquote>") && structure.includes("<li>"),
  structure
);

// ---------------------------------------------------------------------------
section("An Arabic draft exports right to left");
// ---------------------------------------------------------------------------
const { buildDocx } = await import("../lib/docx.ts");
const { unzipText } = await import("./helpers/unzip.mjs");

const arabic = {
  title: "ينأون عنه في صمت",
  blocks: [
    { kind: "paragraph", runs: [{ text: "في نوفمبر سيصوت الأمريكيون" }, { note: 0 }] },
    { kind: "heading", level: 2, runs: [{ text: "عنوان فرعي" }] },
    { kind: "quote", runs: [{ text: "اقتباس", italic: true }] },
    { kind: "bullet", runs: [{ text: "نقطة", bold: true }] },
  ],
  notes: [{ text: "مرجع، الحزب، 2026", url: "https://example.org/a" }],
};

const rtlDoc = unzipText(buildDocx({ ...arabic, rtl: true }), "word/document.xml");
const rtlNotes = unzipText(buildDocx({ ...arabic, rtl: true }), "word/footnotes.xml");
const ltrDoc = unzipText(buildDocx({ ...arabic, rtl: false }), "word/document.xml");

check("the section reads right to left", rtlDoc.includes("<w:sectPr><w:bidi/>"), rtlDoc.slice(-300));
check("every paragraph is bidi", (rtlDoc.match(/<w:bidi\/>/g) ?? []).length >= 5, String((rtlDoc.match(/<w:bidi\/>/g) ?? []).length));
check("the runs are right to left", rtlDoc.includes("<w:rtl/>"));
check("bold carries its complex-script twin", rtlDoc.includes("<w:b/><w:bCs/>"), "bCs missing");
check("so does italic", rtlDoc.includes("<w:i/><w:iCs/>"), "iCs missing");
check("the quote indents from the right", rtlDoc.includes('<w:ind w:right="720"/>'), "indent still left");
check("the footnote reference is right to left too", rtlDoc.includes("<w:rtl/><\/w:rPr><w:footnoteReference"), "note mark not rtl");
check("and the footnote itself", rtlNotes.includes("<w:bidi/>") && rtlNotes.includes("<w:rtl/>"));

check("a left-to-right document has none of it", !ltrDoc.includes("<w:bidi/>") && !ltrDoc.includes("<w:rtl/>"));
check("and still indents its quote from the left", ltrDoc.includes('<w:ind w:left="720"/>'));
check("left to right is still the default", !unzipText(buildDocx(arabic), "word/document.xml").includes("<w:bidi/>"));

// The direction the export route decides on.
const { dirOf } = await import("../lib/dir.ts");
check("an Arabic draft is judged rtl", dirOf("في نوفمبر سيصوت الأمريكيون على انتخاب دونالد ترامب") === "rtl");
check("an English one is not", dirOf("In November Americans will vote") === "ltr");
check(
  "an English draft quoting a little Arabic stays ltr",
  dirOf("The phrase " + "الحزب" + " appears once in this otherwise English sentence about politics.") === "ltr"
);

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
