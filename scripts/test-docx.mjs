/**
 * The Word export, and the ZIP underneath it.
 *
 * A .docx that Word refuses to open is a total failure that no amount of
 * eyeballing the code will catch, so the archive is unpacked and checked
 * structurally: the parts that must exist, the CRCs, and the XML that carries
 * the actual writing.
 *
 *   node scripts/test-docx.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

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
const { buildDocx } = await import("../lib/docx.ts");
const { htmlToDocx, htmlToText } = await import("../lib/richtext.ts");

/** Reads a ZIP the way any unpacker would: from the central directory. */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("no end-of-central-directory record");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);

  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central header");
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressed = buf.readUInt32LE(at + 20);
    const raw = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.slice(at + 46, at + 46 + nameLen).toString("utf8");

    // Follow the offset to the local header, as a real unpacker does.
    const localNameLen = buf.readUInt16LE(offset + 26);
    const localExtraLen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtraLen;
    const body = buf.slice(start, start + compressed);
    const data = method === 0 ? body : zlib.inflateRawSync(body);

    files.set(name, { data, crc, raw, method });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    let x = (c ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1;
    c = x ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------
section("The ZIP is a ZIP");
// ---------------------------------------------------------------------------
{
  const files = unzip(zip([
    { name: "hello.txt", data: "hello world" },
    { name: "nested/dir/file.xml", data: "<a>" + "x".repeat(5000) + "</a>" },
    { name: "empty.txt", data: "" },
  ]));

  check("every entry comes back", files.size === 3);
  check("content survives the round trip", files.get("hello.txt").data.toString() === "hello world");
  check("so do nested paths", files.has("nested/dir/file.xml"));
  check("an empty file is still a file", files.get("empty.txt").data.length === 0);
  check("a compressible file is actually compressed", files.get("nested/dir/file.xml").method === 8);
  check(
    "and a tiny one is stored rather than inflated",
    files.get("hello.txt").method === 0,
    String(files.get("hello.txt").method)
  );

  // A wrong CRC is exactly how an archive opens everywhere except Word.
  let crcOk = true;
  for (const [, f] of files) if (crc32(f.data) !== f.crc) crcOk = false;
  check("every checksum matches its content", crcOk);
  check("declared sizes match reality", [...files.values()].every((f) => f.data.length === f.raw));

  check("UTF-8 names survive", (() => {
    const f = unzip(zip([{ name: "مقالة.xml", data: "<a/>" }]));
    return f.has("مقالة.xml");
  })());

  // Two exports of the same document should be byte-identical.
  const a = zip([{ name: "a.txt", data: "same" }]);
  const b = zip([{ name: "a.txt", data: "same" }]);
  check("the same input gives the same bytes", a.equals(b));
}

// ---------------------------------------------------------------------------
section("The document is a Word document");
// ---------------------------------------------------------------------------
{
  const { blocks, notes } = htmlToDocx(
    `<h1>The concession</h1>` +
      `<p>Standard Oil <b>secured</b> the <i>terms</i>` +
      `<span data-note="0" contenteditable="false">[1]</span> in 1933.</p>` +
      `<blockquote>A quotation from the source.</blockquote>` +
      `<ul><li>First</li><li>Second</li></ul>` +
      `<ol><li>One</li></ol>` +
      `<p>Cited again<span data-note="0" contenteditable="false">[1]</span>, and elsewhere` +
      `<span data-note="1" contenteditable="false">[2]</span>.</p>`,
    [
      { text: "Wald, Saudi, Inc., 2018, p. 42." },
      { text: "Yergin, The Prize, 1991.", url: "https://example.org/prize?a=1&b=2" },
    ]
  );

  check("headings survive", blocks[0].kind === "heading" && blocks[0].level === 1);
  check("so do quotes", blocks.some((b) => b.kind === "quote"));
  check("bulleted and numbered lists are told apart",
    blocks.some((b) => b.kind === "bullet") && blocks.some((b) => b.kind === "number"));
  check("bold and italic survive", (() => {
    const runs = blocks.find((b) => b.kind === "paragraph").runs;
    return runs.some((r) => r.bold && /secured/.test(r.text ?? "")) &&
           runs.some((r) => r.italic && /terms/.test(r.text ?? ""));
  })());

  check("one source cited twice is one footnote", notes.length === 2, String(notes.length));
  check("the note text is the reference", notes[0].text.includes("Saudi, Inc."));
  check("the marker's own number is dropped", !JSON.stringify(blocks).includes("[1]"));
  check("but the surrounding words are kept", JSON.stringify(blocks).includes("in 1933"));

  const file = buildDocx({ title: "On the concession", blocks, notes });
  const parts = unzip(file);

  for (const required of [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
    "word/_rels/document.xml.rels",
    "word/styles.xml",
    "word/numbering.xml",
    "word/footnotes.xml",
  ]) {
    check(`it contains ${required}`, parts.has(required));
  }

  const doc = parts.get("word/document.xml").data.toString("utf8");
  check("the title is in the body", doc.includes("On the concession"));
  check("the prose is in the body", doc.includes("Standard Oil"));
  check("bold is marked up as Word expects", doc.includes("<w:b/>"));
  check("footnote references are anchored", doc.includes("<w:footnoteReference"));
  check("spaces are preserved", doc.includes('xml:space="preserve"'));
  check("it declares a page size", doc.includes("<w:pgSz"));

  const foot = parts.get("word/footnotes.xml").data.toString("utf8");
  check("the separators Word requires are present",
    foot.includes('w:type="separator"') && foot.includes('w:type="continuationSeparator"'));
  check("real notes start at id 2, as the format demands", foot.includes('w:footnote w:id="2"'));
  check("both references are there", foot.includes("Saudi, Inc.") && foot.includes("The Prize"));

  // A note with an address ends in a live link, kept in the part's own
  // relationships as Word requires; a note without one has no link.
  check("a note with an address carries a hyperlink", foot.includes('<w:hyperlink r:id="rIdLink1">'));
  check("the link's text is the address, escaped", foot.includes("https://example.org/prize?a=1&amp;b=2"));
  check("a note without an address has none", (foot.match(/<w:hyperlink /g) ?? []).length === 1);
  check("the footnotes part has its own relationships", parts.has("word/_rels/footnotes.xml.rels"));
  const frels = parts.get("word/_rels/footnotes.xml.rels").data.toString("utf8");
  check(
    "which point the link at the address, externally",
    frels.includes('Id="rIdLink1"') && frels.includes('Target="https://example.org/prize?a=1&amp;b=2"') && frels.includes('TargetMode="External"')
  );
  check("and the link style is defined", parts.get("word/styles.xml").data.toString("utf8").includes('w:styleId="Hyperlink"'));

  check("every part is well-formed enough to declare itself XML",
    [...parts.values()].every((p) => p.data.toString("utf8", 0, 5) === "<?xml"));
}

// ---------------------------------------------------------------------------
section("Nothing user-written can break the XML");
// ---------------------------------------------------------------------------
{
  const nasty = `<p>Ampersands & angle <brackets>, "quotes" and 'apostrophes'</p>`;
  const { blocks } = htmlToDocx(nasty, []);
  const doc = unzip(buildDocx({ title: 'A & B <c>', blocks, notes: [] }))
    .get("word/document.xml").data
    .toString("utf8");

  check("a bare ampersand is escaped", !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(doc));
  check("the title's angle brackets are escaped", doc.includes("A &amp; B"));
  check("and the text still reads correctly", doc.includes("Ampersands &amp;"));

  // Control characters are illegal in XML and make Word reject the file
  // outright rather than complain about one character.
  const control = htmlToDocx("<p>badchar</p>", []);
  const out = unzip(buildDocx({ title: "t", blocks: control.blocks, notes: [] }))
    .get("word/document.xml").data
    .toString("utf8");
  // eslint-disable-next-line no-control-regex
  check("control characters are stripped", !/[ --]/.test(out));
}

// ---------------------------------------------------------------------------
section("Plain text for the fact-check");
// ---------------------------------------------------------------------------
{
  const text = htmlToText("<h1>Title</h1><p>First para.</p><p>Second <b>bold</b> para.</p>");
  check("tags are gone", !text.includes("<"));
  check("paragraphs stay separated", text.includes("First para.\n\nSecond"));
  check("entities are decoded", htmlToText("<p>a &amp; b &lt;c&gt;</p>") === "a & b <c>");
  check("an empty draft is empty", htmlToText("<p><br></p>") === "");

  // The first line a writer types sits in no block at all, so the break before
  // the next paragraph has to come from that paragraph opening rather than
  // from a closing tag. Without it the two ran together as "First.Second.".
  check(
    "a bare opening line is not welded to the paragraph after it",
    htmlToText("First para.<p>Second para.</p>") === "First para.\n\nSecond para.",
    JSON.stringify(htmlToText("First para.<p>Second para.</p>"))
  );
  check(
    "and the divs contenteditable emits break the same way",
    htmlToText("First.<div>Second.</div><div>Third.</div>") === "First.\n\nSecond.\n\nThird.",
    JSON.stringify(htmlToText("First.<div>Second.</div><div>Third.</div>"))
  );
  check(
    "a list still reads as separate items",
    htmlToText("<ul><li>One</li><li>Two</li></ul>") === "One\n\nTwo",
    JSON.stringify(htmlToText("<ul><li>One</li><li>Two</li></ul>"))
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
