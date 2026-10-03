/**
 * Word, spreadsheets, slides and photographs: read without a converter.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-office.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const SANDBOX = path.join(root, "data", "__office__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.CORPUS_DATA_DIR = SANDBOX;
process.env.CORPUS_FOLLOWER = "1"; // the test reads; the worker stays off
fs.writeFileSync(path.join(SANDBOX, "config.json"), JSON.stringify({ requestsPerMinute: 0 }));

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

const { zip } = await import("../lib/zip.ts");
const office = await import("../lib/ingest/office.ts");
const { parseText } = await import("../lib/ingest/text.ts");
const all = (r) => r.pieces.map((p) => p.text).join("\n");

section("Word");
const docx = zip([
  { name: "[Content_Types].xml", data: "<Types/>" },
  {
    name: "docProps/core.xml",
    data: '<cp:coreProperties><dc:title>Sanctions memo</dc:title><dc:creator>Test Author</dc:creator></cp:coreProperties>',
  },
  {
    name: "word/document.xml",
    data:
      '<w:document><w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Shipments</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">The tanker KAVITA </w:t></w:r><w:r><w:t>sailed &amp; docked.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>تم توقيع المعاهدة في عام 1919.</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Ship</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Flag</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:p><w:r><w:t>KAVITA</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Palau</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '</w:body></w:document>',
  },
]);
const d = office.parseDocx(docx);
check("title and author come from the document", d.meta.title === "Sanctions memo" && d.meta.author === "Test Author");
check("runs join into one sentence, entities decoded", all(d).includes("The tanker KAVITA sailed & docked."));
check("Arabic survives", all(d).includes("تم توقيع المعاهدة"));
check("a table reads as rows of cells", all(d).includes("Ship | Flag") && all(d).includes("KAVITA | Palau"));
check("a heading labels its section", d.pieces[0].label === "Shipments");
check("the last row of a table is not taken for a heading", all(d).trim().endsWith("KAVITA | Palau"));

section("Spreadsheets");
const xlsx = zip([
  {
    name: "xl/workbook.xml",
    data: '<workbook><sheets><sheet name="Cargo" sheetId="1" r:id="rId1"/><sheet name="Owners" sheetId="2" r:id="rId2"/></sheets></workbook>',
  },
  {
    name: "xl/_rels/workbook.xml.rels",
    data:
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  },
  { name: "xl/sharedStrings.xml", data: "<sst><si><t>Container</t></si><si><t>Tons</t></si><si><r><t>شح</t></r><r><t>نة</t></r></si></sst>" },
  {
    name: "xl/worksheets/sheet1.xml",
    data:
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>MSKU9070323</t></is></c><c r="B2"><v>21.5</v></c><c r="D2" t="s"><v>2</v></c></row></sheetData></worksheet>',
  },
  { name: "xl/worksheets/sheet2.xml", data: '<worksheet><sheetData><row r="1"><c r="A1" t="b"><v>1</v></c></row></sheetData></worksheet>' },
]);
const x = office.parseXlsx(xlsx);
check("each sheet is its own section", x.pieces.map((p) => p.label).join() === "Sheet: Cargo,Sheet: Owners");
check("cells line up, gaps kept", all(x).includes("MSKU9070323 | 21.5 |  | شحنة"), all(x));
check("shared, inline, number and true/false cells", all(x).includes("Container | Tons") && all(x).includes("TRUE"));

section("Slides");
const pptx = zip([
  { name: "ppt/slides/slide2.xml", data: "<p:sld><a:p><a:r><a:t>Next steps</a:t></a:r></a:p></p:sld>" },
  { name: "ppt/slides/slide10.xml", data: "<p:sld><a:p><a:r><a:t>Tenth</a:t></a:r></a:p></p:sld>" },
  { name: "ppt/slides/slide1.xml", data: "<p:sld><a:p><a:r><a:t>Briefing</a:t></a:r></a:p><a:p><a:r><a:t>Iran shipments rose</a:t></a:r></a:p></p:sld>" },
  { name: "ppt/notesSlides/notesSlide1.xml", data: "<p:notes><a:p><a:r><a:t>Source: customs data</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>" },
]);
const p = office.parsePptx(pptx);
check("slides in their own order, not the zip's", p.pieces.map((s) => s.label).join() === "Slide 1,Slide 2,Slide 3", p.pieces.map((s) => s.label).join());
check("the speaker's notes come with the slide", p.pieces[0].text.includes("Notes:\nSource: customs data"));
check("the notes' slide number is not read as a note", !/Notes:[\s\S]*\n1$/.test(p.pieces[0].text));

section("OpenDocument");
const odt = zip([
  {
    name: "content.xml",
    data:
      '<office:document-content><office:body><office:text><text:h text:outline-level="1">Memo</text:h><text:p>One<text:s text:c="2"/>two<text:tab/>three</text:p>' +
      '<table:table table:name="T"><table:table-row><table:table-cell><text:p>Ship</text:p></table:table-cell><table:table-cell><text:p>Flag</text:p></table:table-cell></table:table-row>' +
      '<table:table-row><table:table-cell><text:p>KAVITA</text:p></table:table-cell><table:table-cell><text:p>Palau</text:p></table:table-cell></table:table-row></table:table>' +
      "</office:text></office:body></office:document-content>",
  },
]);
const o = office.parseOdt(odt);
// text:s with c="2" stands for exactly two spaces.
check("spaces and tabs are honoured", all(o).includes("One  two\tthree"), JSON.stringify(all(o)));
check("a table reads as rows here too", all(o).includes("Ship | Flag") && all(o).includes("KAVITA | Palau"), all(o));
const ods = zip([
  {
    name: "content.xml",
    data:
      '<office:spreadsheet><table:table table:name="Cargo"><table:table-row><table:table-cell><text:p>A</text:p></table:table-cell>' +
      '<table:table-cell table:number-columns-repeated="16380"/></table:table-row>' +
      '<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table></office:spreadsheet>',
  },
]);
const t0 = Date.now();
const s = office.parseOds(ods);
check("an empty run to the sheet's edge is not spelled out", all(s) === "Sheet: Cargo\n\nA" && Date.now() - t0 < 2000, JSON.stringify(all(s)));

section("Text");
check(
  "a last line that looks like a heading is kept, not lost",
  parseText("one\ntwo\nthree\nfour\nfive\nsix\nseven\nKAVITA | Palau").map((x) => x.text).join("\n").includes("KAVITA | Palau")
);

section("Adding files");
const { addFile } = await import("../lib/ingest/index.ts");
const { db } = await import("../lib/db/index.ts");
const word = await addFile({ filename: "memo.docx", bytes: docx });
const src = db().prepare("SELECT title, author, kind FROM sources WHERE id=?").get(word.sourceId);
check("a Word file becomes a source, titled from inside it", src.title === "Sanctions memo" && src.author === "Test Author", JSON.stringify(src));
const sheet = await addFile({ filename: "cargo.xlsx", bytes: xlsx });
check("so does a spreadsheet", db().prepare("SELECT COUNT(*) n FROM chunks WHERE source_id=?").get(sheet.sourceId).n > 0);
// A one-pixel PNG.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);
const photo = await addFile({ filename: "page.jpg", bytes: png });
const ph = db().prepare("SELECT kind, path FROM sources WHERE id=?").get(photo.sourceId);
check("a photo becomes a one-page scan, even one misnamed .jpg", ph.kind === "pdf" && ph.path.endsWith(".pdf"));
check("its page is queued to be read", db().prepare("SELECT COUNT(*) n FROM tasks WHERE run_id=? AND kind='ocr'").get(photo.runId).n === 1);
for (const [name, says] of [
  ["old.doc", /save it as \.docx/i],
  ["scan.heic", /PNG or JPG/],
  ["bundle.zip", /Folder or zip/],
]) {
  let message = "";
  try {
    await addFile({ filename: name, bytes: Buffer.from("x") });
  } catch (e) {
    message = e.message;
  }
  check(`${name} is refused with what to do instead`, says.test(message), message);
}
let notPicture = "";
try {
  await addFile({ filename: "fake.png", bytes: Buffer.from("not an image") });
} catch (e) {
  notPicture = e.message;
}
check("a file that only claims to be a picture says so", /not a picture/.test(notPicture), notPicture);

db().close?.();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
