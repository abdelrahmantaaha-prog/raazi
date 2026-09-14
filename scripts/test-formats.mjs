/**
 * Exercises every ingest parser without spending a single API call: the parsing
 * stage is deliberately free, and this proves it.
 *
 *   npx tsx scripts/test-formats.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { zipSync, strToU8 } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
process.env.CORPUS_DATA_DIR = path.join(root, "data", "__fmt__");

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
section("PDF — born-digital pages cost nothing, scans get routed to OCR");
// ---------------------------------------------------------------------------
const { parsePdf } = await import("../lib/ingest/pdf.ts");

const pdf = await PDFDocument.create();
pdf.setTitle("A Test Monograph");
pdf.setAuthor("R. Tester");
const font = await pdf.embedFont(StandardFonts.TimesRoman);

// Page 1: real text.
const p1 = pdf.addPage([600, 800]);
const lines = [
  "The Free Officers Movement was formed in Cairo in 1949 by a small",
  "circle of army officers who had served in Palestine. Gamal Abdel",
  "Nasser was its founding chairman, and it was Nasser who drew up",
  "the movement's first list of members and set its early direction.",
];
lines.forEach((l, i) => p1.drawText(l, { x: 50, y: 700 - i * 22, size: 12, font }));

// Page 2: no text at all — this is what a scanned page looks like to a parser.
pdf.addPage([600, 800]);

const parsed = await parsePdf(Buffer.from(await pdf.save()));
check("reads the text page without any model call", parsed.pieces.length === 1, `${parsed.pieces.length} pieces`);
check("that page carries its page number for citations", parsed.pieces[0]?.locator.page === 1);
check("recovers the sentence across pdf's positioned fragments",
  /Free Officers Movement was formed in Cairo in 1949/.test(parsed.pieces[0]?.text ?? ""),
  JSON.stringify((parsed.pieces[0]?.text ?? "").slice(0, 80)));
check("flags the empty page as a scan needing OCR", parsed.scannedPages.join() === "2", parsed.scannedPages.join());
check("picks up the PDF's own title metadata", parsed.meta.title === "A Test Monograph", parsed.meta.title);
check("and its author", parsed.meta.author === "R. Tester", parsed.meta.author);

// ---------------------------------------------------------------------------
section("EPUB — chapters and metadata straight out of the manifest");
// ---------------------------------------------------------------------------
const { parseEpub } = await import("../lib/ingest/epub.ts");

const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Autumn of Fury</dc:title>
    <dc:creator>Mohamed Heikal</dc:creator>
    <dc:language>en</dc:language>
    <dc:publisher>Andre Deutsch</dc:publisher>
    <dc:date>1983-01-01</dc:date>
  </metadata>
  <manifest>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;

const chapter = (title, body) =>
  `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

const epubBytes = Buffer.from(
  zipSync({
    "mimetype": strToU8("application/epub+zip"),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/ch1.xhtml": strToU8(
      chapter("The Vice President", "Anwar Sadat spent eighteen years in Nasser's shadow, and was widely regarded as a placeholder when he took office in 1970.")
    ),
    "OEBPS/ch2.xhtml": strToU8(
      chapter("October", "The crossing of the Suez Canal in 1973 transformed Sadat's standing at home, and gave him the standing to go to Jerusalem four years later.")
    ),
  })
);

const epub = parseEpub(epubBytes);
check("walks the spine in reading order", epub.pieces.length === 2, `${epub.pieces.length} chapters`);
check("keeps chapter titles as citation labels", epub.pieces[0].label === "The Vice President", epub.pieces[0].label);
check("strips the markup but keeps the prose", /eighteen years in Nasser's shadow/.test(epub.pieces[0].text));
check("reads title and author from the manifest",
  epub.meta.title === "Autumn of Fury" && epub.meta.author === "Mohamed Heikal",
  JSON.stringify(epub.meta));
check("and the year, for citations", epub.meta.year === "1983", epub.meta.year);

// ---------------------------------------------------------------------------
section("Markdown — headings become the locator");
// ---------------------------------------------------------------------------
const { parseText } = await import("../lib/ingest/text.ts");
const md = parseText(`# Origins

The movement began in Cairo.

## The Palestine War

Nasser was wounded at Faluja in 1948.
`);
check("splits on headings", md.length >= 2, `${md.length} sections`);
check("each section knows which heading it sits under",
  md.every((p) => typeof p.label === "string" && p.label.length > 0),
  JSON.stringify(md.map((p) => p.label)));

// ---------------------------------------------------------------------------
section("URL — readable article text out of a live page");
// ---------------------------------------------------------------------------
const { parseUrl } = await import("../lib/ingest/web.ts");
try {
  const web = await parseUrl("https://en.wikipedia.org/wiki/Free_Officers_Movement_(Egypt)");
  const words = web.pieces.reduce((n, p) => n + p.text.split(/\s+/).length, 0);
  check("extracts a substantial body of article text", words > 300, `${words} words`);
  check("captures a title for the citation", Boolean(web.meta.title), JSON.stringify(web.meta.title));
  check("records the publisher", Boolean(web.meta.publisher), JSON.stringify(web.meta.publisher));
  check("drops the chrome — no nav junk in the body",
    !/Jump to content|Main page\s+Contents/i.test(web.pieces[0].text),
    web.pieces[0].text.slice(0, 60));
} catch (err) {
  console.log(`  skip  URL parsing — no network or the page refused: ${err.message}`);
}

// ---------------------------------------------------------------------------
section("Cleaning — dropping what costs tokens and says nothing");
// ---------------------------------------------------------------------------
const { clean } = await import("../lib/ingest/clean.ts");

const prosePage = (n) => ({
  label: `p. ${n}`,
  locator: { page: n },
  text: `The Journal of Contemporary History\n\nNasser's decision to nationalise the canal was taken in the week after the American withdrawal of the Aswan loan. He announced it in Alexandria on 26 July 1956, and the crowd understood before he finished the sentence.\n\n${n}`,
});

const notesPage = (n) => ({
  label: `p. ${n}`,
  locator: { page: n },
  text:
    `The Journal of Contemporary History\n\n` +
    `1 Vaughan, Don. 2023. "Scorched-earth policy." Encyclopedia Britannica. Retrieved 4 May 2024.\n` +
    `2 Mihesuah, Devon A. 1997. American Indians: Stereotypes and Realities. Atlanta: Clarity, pp. 21-34.\n` +
    `3 Heikal, Mohamed. 1986. Cutting the Lion's Tail. London: Deutsch. Available at https://example.org/x\n` +
    `4 Ibid., vol. 2.\n` +
    `5 Rogan, Eugene. 2015. The Arabs: A History. New York: Basic Books, pp. 402-410.\n\n${n}`,
});

const pages = [];
for (let i = 1; i <= 10; i++) pages.push(i % 3 === 0 ? notesPage(i) : prosePage(i));

const cleaned = clean(pages);
const keptText = cleaned.pieces.map((p) => p.text).join("\n");

check("reference pages are dropped", cleaned.dropped.apparatusPieces === 3, String(cleaned.dropped.apparatusPieces));
check("the argument is kept", /nationalise the canal/.test(keptText));
check("no bibliography survives into the text", !/Encyclopedia Britannica/.test(keptText));
check(
  "the running head repeated on every page is stripped",
  !/Journal of Contemporary History/.test(keptText),
  keptText.slice(0, 60)
);
check("bare page numbers go too", !/^\s*\d+\s*$/m.test(keptText));
check("and it reports a real saving", cleaned.dropped.tokensSaved > 0);

// The failure that would matter: deleting prose that merely cites something.
const citing = [
  {
    label: "p. 1",
    locator: { page: 1 },
    text: `Heikal, Mohamed. 1986. He argued that the decision was taken alone.\n\nThe crowd in Alexandria heard the codeword and understood. Rogan (2015) calls this the turning point of the decade, and the archives bear him out on the timing if not the significance.\n\nWhat followed was not the war Eden wanted.`,
  },
];
const citingClean = clean(citing);
check(
  "a passage that cites sources is NOT mistaken for a bibliography",
  /crowd in Alexandria/.test(citingClean.pieces.map((p) => p.text).join("")),
  "prose was deleted"
);

check(
  "hyphens splitting a word across lines are repaired",
  clean([{ label: "x", locator: {}, text: "the govern-\nment fell" }]).pieces[0].text.includes("government"),
  clean([{ label: "x", locator: {}, text: "the govern-\nment fell" }]).pieces[0].text
);

// ---------------------------------------------------------------------------
section("URL — structure survives as Markdown");
// ---------------------------------------------------------------------------
const { htmlToMarkdown } = await import("../lib/ingest/web.ts");
const articleMd = htmlToMarkdown(
  `<div><h2>Origins</h2><p>The movement began in <strong>Cairo</strong>.</p>` +
    `<ul><li>First point</li><li>Second point</li></ul>` +
    `<blockquote>We wanted the army to be the vanguard.</blockquote>` +
    `<figure><img src="x.png"><figcaption>A caption</figcaption></figure></div>`
);
check("headings become Markdown headings", /^## Origins$/m.test(articleMd), JSON.stringify(articleMd.slice(0, 40)));
check("emphasis survives", /\*\*Cairo\*\*/.test(articleMd));
check("lists survive", /^- First point$/m.test(articleMd));
check("quotes survive", /^> We wanted the army/m.test(articleMd));
check("figures and captions are dropped", !/A caption/.test(articleMd));

// ---------------------------------------------------------------------------
section("URL — what the page says about itself");
// ---------------------------------------------------------------------------
{
  const { readMeta, canonicalUrl, normaliseLang } = await import("../lib/ingest/web.ts");
  const { JSDOM } = await import("jsdom");
  const html = `<html lang="en-CA"><head>
    <title>Fallback title</title>
    <meta property="og:title" content="Tariff talks stall">
    <meta property="og:site_name" content="The Globe and Mail">
    <meta name="author" content="Jane Doe">
    <meta property="article:published_time" content="2026-03-04T14:00:00-05:00">
    <meta property="article:section" content="Politics">
    <link rel="canonical" href="https://www.theglobeandmail.com/politics/article-tariffs/">
  </head><body><p>x</p></body></html>`;
  const page = "https://www.theglobeandmail.com/politics/article-tariffs/?utm_source=twitter#comments";
  const meta = readMeta(new JSDOM(html, { url: page }).window.document, page);
  check("published_at is the full timestamp in UTC", meta.publishedAt === "2026-03-04T19:00:00.000Z", meta.publishedAt);
  check("year follows from it", meta.year === "2026");
  check("the outlet is og:site_name", meta.outlet === "The Globe and Mail");
  check("the section is read", meta.section === "Politics");
  check("the canonical URL is the declared one", meta.canonicalUrl === "https://www.theglobeandmail.com/politics/article-tariffs");
  check("the language is a primary tag", meta.lang === "en");
  check("the title prefers og:title", meta.title === "Tariff talks stall");

  const bare = readMeta(new JSDOM("<html><head><title>T</title></head><body></body></html>", { url: "https://News.Example.com/a?gclid=1" }).window.document, "https://News.Example.com/a?gclid=1");
  check("without og:site_name the outlet is the host", bare.outlet === "news.example.com");
  check("without a canonical link the URL is cleaned", bare.canonicalUrl === "https://news.example.com/a");
  check("without a date there is no year", bare.year === undefined && bare.publishedAt === undefined);
  check("the helpers are re-exported for callers of web.ts", typeof canonicalUrl === "function" && normaliseLang("eng") === "en");
}

// ---------------------------------------------------------------------------
section("URL — a loading screen is not the article");
// ---------------------------------------------------------------------------
{
  const { dropOverlays } = await import("../lib/ingest/web.ts");
  const { JSDOM } = await import("jsdom");
  const { Readability } = await import("@mozilla/readability");

  const prose = Array.from({ length: 6 }, (_, i) =>
    `<p>Paragraph ${i + 1} of the forum report: the speaker traced the argument through the archives and the audience pressed him on the dates, the sources and what the record leaves out.</p>`
  ).join("");
  const page = (body) => new JSDOM(`<html><body>${body}</body></html>`, { url: "https://site.example/ArticleID/1" }).window.document;
  const read = (doc) => new Readability(doc).parse()?.textContent ?? "";

  // Shoman's shape: a logo and the foundation's tagline in a loader ahead of everything.
  const shoman = page(
    `<div class="page-loaders"><div class="loading-center has-logo"><img src="logo.svg"><span>A cultural arm tagline</span></div></div>` +
      `<div class="content"><article>${prose}</article></div>`
  );
  check("the loader is removed", dropOverlays(shoman) >= 1);
  const text = read(shoman);
  check("its tagline does not open the article", !text.includes("tagline"), text.slice(0, 80));
  check("the article is all still there", text.includes("Paragraph 1") && text.includes("Paragraph 6"));

  const others = page(
    `<div id="preloader">Loading…</div><div class="spinner"></div>` +
      `<article class="story is-loading">${prose}<img class="lazyload" src="a.jpg"></article>`
  );
  dropOverlays(others);
  check("a preloader and a spinner go too", !others.getElementById("preloader") && !others.querySelector(".spinner"));
  check("a container still marked loading keeps its article", others.querySelector("article.is-loading") !== null);
  check("a lazy-loaded picture is not an overlay", others.querySelector("img.lazyload") !== null);
}

fs.rmSync(path.join(root, "data", "__fmt__"), { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
