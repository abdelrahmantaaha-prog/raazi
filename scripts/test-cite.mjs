/**
 * What a reference carries, and where an outside link opens.
 *
 * From the 20 September 2026 audit of the writing desk. Four buttons cite
 * into a draft and each sent a different subset of the fields, so references
 * landed with author, title, year and outlet all null; `formatCitation` had
 * no outlet parameter at all, so even the rendered string named the byline
 * and the headline and not the paper; and the address, which was stored,
 * was shown nowhere.
 *
 * Runs against a scratch database. No API key needed.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-cite.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__cite__");
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
section("A citation names the publication");
// ---------------------------------------------------------------------------
const { formatCitation } = await import("../lib/citation.ts");

check(
  "the outlet sits after the title",
  formatCitation({ author: "Amy B Wang", title: "California signs an AI order", outlet: "The Washington Post", year: "2026" }) ===
    "Amy B Wang, California signs an AI order, The Washington Post, 2026",
  formatCitation({ author: "Amy B Wang", title: "California signs an AI order", outlet: "The Washington Post", year: "2026" })
);
check(
  "an outlet that repeats the author is dropped",
  formatCitation({ author: "Reuters", title: "Senate blocks the bill", outlet: "Reuters" }) ===
    "Reuters, Senate blocks the bill"
);
check(
  "and so is one that only differs by a leading The",
  formatCitation({ author: "The Guardian", title: "A headline", outlet: "Guardian" }) === "The Guardian, A headline"
);
check(
  "an outlet that repeats the title is dropped",
  formatCitation({ title: "Politico", outlet: "Politico" }) === "Politico"
);
check(
  "no outlet still reads as it always did",
  formatCitation({ author: "Michael Walzer", title: "What it means to be an American", locator: "p. 54" }) ===
    "Michael Walzer, What it means to be an American, p. 54"
);
check(
  "a locator that repeats the title is still dropped",
  formatCitation({ title: "Usha Vance", locator: "Usha Vance" }) === "Usha Vance"
);

// ---------------------------------------------------------------------------
section("A reference is completed from its source");
// ---------------------------------------------------------------------------
const { db } = await import("../lib/db/index.ts");
const { createDraft, addCitation, updateCitation } = await import("../lib/drafts.ts");

db()
  .prepare(
    `INSERT INTO sources (id, title, author, year, outlet, url, kind, status)
     VALUES (901, 'Iowa Republicans join the vote', 'Lisa Mascaro', '2026', 'PBS NewsHour',
             'https://www.pbs.org/newshour/politics/iowa', 'text', 'ready')`
  )
  .run();

const draftId = createDraft("A piece about the vote");

// The shelf's Cite button: the rendered text and a source id, nothing else.
// This is the call that used to leave every other column null.
let refs = addCitation(draftId, { origin: "library", text: "", source_id: 901 });
const one = refs[refs.length - 1];
check("the author comes from the source", one.author === "Lisa Mascaro");
check("the title comes from the source", one.title === "Iowa Republicans join the vote");
check("the year comes from the source", one.year === "2026");
check("the outlet comes from the source", one.outlet === "PBS NewsHour", String(one.outlet));
check("the address comes from the source", one.url === "https://www.pbs.org/newshour/politics/iowa");
check(
  "and the rendered reference names the outlet",
  one.text === "Lisa Mascaro, Iowa Republicans join the vote, PBS NewsHour, 2026",
  one.text
);

// A caller that does supply fields is not overridden by the source.
refs = addCitation(draftId, { origin: "library", source_id: 901, locator: "p. 4", author: "Someone Else" });
const two = refs[refs.length - 1];
check("what the caller passed wins", two.author === "Someone Else");
check("the locator it passed is kept", two.locator === "p. 4");
check("and the outlet is still filled in", two.outlet === "PBS NewsHour");

// A reference with nothing behind it in the library still works.
refs = addCitation(draftId, { origin: "outside", url: "https://example.org/a" });
const three = refs[refs.length - 1];
check("an outside reference keeps its address", three.url === "https://example.org/a");
check("and still renders to something", three.text.length > 0, three.text);

// ---------------------------------------------------------------------------
section("Editing a reference does not reshape it");
// ---------------------------------------------------------------------------
// add rendered "Author, Title, Outlet, Year"; update used to render the same
// with the address appended, so correcting a typo changed the whole shape.
const edited = updateCitation(draftId, one.id, { title: "Iowa Republicans join the war vote" });
const after = edited.find((r) => r.id === one.id);
check(
  "the corrected reference keeps its shape",
  after.text === "Lisa Mascaro, Iowa Republicans join the war vote, PBS NewsHour, 2026",
  after.text
);
check("and does not grow a URL in the middle of the sentence", !after.text.includes("http"), after.text);
check("while the address is still on the row", after.url === "https://www.pbs.org/newshour/politics/iowa");

// ---------------------------------------------------------------------------
section("A reference without a year survives the library being opened again");
// ---------------------------------------------------------------------------
// The migration runs on every open. Without a year the new rendering starts
// with the old one, and the outlet was taken for a locator and written out
// once more each time — en.wikisource.org ninety times by 16 October 2026.
const { migrateCitations } = await import("../lib/db/migrate-citations.ts");

db()
  .prepare(
    `INSERT INTO sources (id, title, author, year, outlet, url, kind, status)
     VALUES (902, 'Leadership and structure', NULL, NULL, 'FEC.gov',
             'https://www.fec.gov/about/leadership-and-structure/', 'url', 'ready'),
            (903, 'Address to the Knights of Columbus', 'Theodore Roosevelt', NULL, 'en.wikisource.org',
             'https://en.wikisource.org/wiki/Address_to_the_Knights_of_Columbus', 'url', 'ready')`
  )
  .run();

refs = addCitation(draftId, { origin: "library", text: "", source_id: 902 });
const yearless = refs[refs.length - 1];
refs = addCitation(draftId, { origin: "library", text: "", source_id: 903, locator: "para. 3" });
const yearlessAt = refs[refs.length - 1];
check("a year-less reference names its outlet once", yearless.text === "Leadership and structure, FEC.gov", yearless.text);

const textOf = (id) => db().prepare("SELECT text FROM draft_citations WHERE id=?").get(id).text;
const changed = [];
for (let i = 0; i < 5; i++) changed.push(migrateCitations(db()));
check("five more opens change nothing", changed.every((n) => n === 0), changed.join(","));
check("and the outlet is still there once", textOf(yearless.id) === "Leadership and structure, FEC.gov", textOf(yearless.id));
check(
  "a year-less reference with a locator keeps both, once",
  textOf(yearlessAt.id) === "Theodore Roosevelt, Address to the Knights of Columbus, en.wikisource.org, para. 3",
  textOf(yearlessAt.id)
);
check("the reference with a year is untouched too", textOf(one.id) === after.text, textOf(one.id));

// What the broken migration left behind is the formatter's own output, so
// the next open folds it back to a single outlet — and then leaves it alone.
db()
  .prepare("UPDATE draft_citations SET text=? WHERE id=?")
  .run(`Leadership and structure${", FEC.gov".repeat(19)}`, yearless.id);
check("a reference with the outlet repeated is mended", migrateCitations(db()) === 1);
check("down to a single outlet", textOf(yearless.id) === "Leadership and structure, FEC.gov", textOf(yearless.id));
check("and stays that way", migrateCitations(db()) === 0 && textOf(yearless.id) === "Leadership and structure, FEC.gov");

// A reference corrected by hand is still left alone.
db().prepare("UPDATE draft_citations SET text=? WHERE id=?").run("FEC, Leadership (2024)", yearless.id);
check("a hand-edited reference is not rewritten", migrateCitations(db()) === 0 && textOf(yearless.id) === "FEC, Leadership (2024)");

// ---------------------------------------------------------------------------
section("Outside links open in the one article window");
// ---------------------------------------------------------------------------
const { articleHref, hostOf, ARTICLE_WINDOW } = await import("../app/components/ArticleLink.tsx");

check("every article link goes through the bounce", articleHref("https://a.test/x").startsWith("/read?u="));
check(
  "the address survives encoding",
  decodeURIComponent(articleHref("https://a.test/x?y=1&z=2").slice("/read?u=".length)) ===
    "https://a.test/x?y=1&z=2"
);
check("an ampersand cannot break out of the parameter", !articleHref("https://a.test/?a=1&b=2").endsWith("b=2"));
check("they all share one window name", ARTICLE_WINDOW === "corpus-article");
check("the host drops the www", hostOf("https://www.washingtonpost.com/politics/x") === "washingtonpost.com");
check("a bare host is left alone", hostOf("https://pbs.org/a") === "pbs.org");
check("something that is not a URL comes back unchanged", hostOf("not a url") === "not a url");

// ---------------------------------------------------------------------------
section("The bounce page only forwards to the web");
// ---------------------------------------------------------------------------
const { GET } = await import("../app/read/route.ts");

const bounce = async (u) => {
  const res = await GET(new Request(`http://127.0.0.1:5400/read?u=${encodeURIComponent(u)}`));
  return await res.text();
};

const good = await bounce("https://example.org/story");
check("an https link is forwarded", good.includes('location.replace("https://example.org/story")'), good.slice(0, 200));
check("and the opener is dropped first", good.indexOf("window.opener = null") < good.indexOf("location.replace"));

const script = await bounce("javascript:alert(1)");
check("a javascript: link is refused", !script.includes("location.replace"), script.slice(0, 160));
const data = await bounce("data:text/html,<script>alert(1)</script>");
check("a data: link is refused", !data.includes("location.replace"));
const junk = await bounce("not a url at all");
check("a non-address is refused", !junk.includes("location.replace"));

// The address is written into a script, so it must not be able to close it.
const nasty = await bounce("https://example.org/</script><script>alert(1)</script>");
check("a closing script tag cannot escape the string", !/<\/script><script>alert/.test(nasty), nasty.slice(0, 300));

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
