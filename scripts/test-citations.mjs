/**
 * A draft's citations stay attached to the right source.
 *
 * Reported on 15 October 2026: citations on the writing desk were "wonky and
 * non-sticky", a marker could lose its footnote through copy and paste, and
 * the same source could sit in the reference list twice. Four causes:
 *
 * - Markers were numbered by the order references were added, while Word
 *   numbered footnotes by first appearance, so a draft read "[2] … [1]".
 * - A paste kept its markers only when the clipboard's plain text matched the
 *   last copy exactly; otherwise each became the literal text "[3]", which a
 *   later deletion then pointed at a different source.
 * - The save stripped `contenteditable="false"`, so a reopened marker could
 *   be typed into, and the export dropped whatever was typed there.
 * - Every Cite click added a reference, even for a source already listed.
 *
 * Runs against a scratch database. No API key needed. The clipboard itself
 * needs a browser and is exercised there; its markup rules are tested in
 * test-draft-move.mjs.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-citations.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__citations__");
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

const { db } = await import("../lib/db/index.ts");
const drafts = await import("../lib/drafts.ts");
const { markerHtml, citeOrder, strayBrackets } = await import("../lib/cite-markers.ts");
const { htmlToDocx } = await import("../lib/richtext.ts");
const { formatCitation } = await import("../lib/citation.ts");

const source = (title, extra = {}) =>
  Number(
    db()
      .prepare(
        `INSERT INTO sources (title, author, outlet, year, published_at, url, kind, status)
         VALUES (@title, @author, @outlet, @year, @published_at, @url, 'url', 'ready')`
      )
      .run({ author: null, outlet: null, year: null, published_at: null, url: null, title, ...extra }).lastInsertRowid
  );

// ---------------------------------------------------------------------------
section("Citing a source already in the list reuses it");
// ---------------------------------------------------------------------------
{
  const s = source("Trends in World Military Expenditure, 2025", { outlet: "SIPRI", year: "2026" });
  const book = source("A long book", { author: "A. Writer" });
  const d = drafts.createDraft("Twice");

  const a = drafts.citeReference(d, { origin: "library", source_id: s, text: "whatever the shelf showed, Africa" });
  const b = drafts.citeReference(d, { origin: "library", source_id: s, locator: "Text" });
  check("the second citation of a source gets the first one's id", a.id !== null && a.id === b.id, `${a.id} ${b.id}`);
  check("and the list holds it once", b.citations.length === 1, String(b.citations.length));

  const p4 = drafts.citeReference(d, { origin: "library", source_id: book, locator: "p. 4" });
  const p9 = drafts.citeReference(d, { origin: "library", source_id: book, locator: "p. 9" });
  const p4again = drafts.citeReference(d, { origin: "library", source_id: book, locator: "p. 4" });
  check("different pages of one book are different references", p4.id !== p9.id);
  check("the same page again is the same reference", p4again.id === p4.id);

  const o1 = drafts.citeReference(d, { origin: "outside", text: "Klein, The Shock Doctrine, 2007" });
  const o2 = drafts.citeReference(d, { origin: "outside", text: "klein, the shock doctrine, 2007." });
  check("an outside reference typed the same way twice is one", o1.id === o2.id);
  const u1 = drafts.citeReference(d, { origin: "outside", title: "A page", url: "https://example.org/a/" });
  const u2 = drafts.citeReference(d, { origin: "outside", title: "The same page", url: "https://example.org/a" });
  check("two outside references to one address are one", u1.id === u2.id);
}

// ---------------------------------------------------------------------------
section("A library reference reads from its source");
// ---------------------------------------------------------------------------
{
  const d = drafts.createDraft("Reads");
  const statista = source("Military expenditure share of GDP in Israel 2025 | Statista", { outlet: "Statista" });
  const toi = source("Israel has higher cost of living", {
    author: "By Nurit Yohanan",
    outlet: "timesofisrael.com",
    published_at: "2026-10-01T08:00:00Z",
  });
  const r1 = drafts.citeReference(d, { origin: "library", source_id: statista, text: "x, Statista, Statista, Statista" });
  const r2 = drafts.citeReference(d, { origin: "library", source_id: toi });
  const list = drafts.citationsFor(d);
  const one = list.find((r) => r.id === r1.id);
  const two = list.find((r) => r.id === r2.id);
  check("the site name is not repeated after the headline", one.text === "Military expenditure share of GDP in Israel 2025, Statista", one.text);
  check("a byline loses its 'By'", two.text.startsWith("Nurit Yohanan, "), two.text);
  check("an article with no year is dated by its publication", two.year === "2026" && two.text.endsWith(", 2026"), two.text);

  // The place comes from the passage's chunk when the button did not say.
  const book = source("Collected Essays");
  const chunk = Number(
    db()
      .prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, 'words', ?)")
      .run(book, JSON.stringify({ page: 142 })).lastInsertRowid
  );
  const r3 = drafts.citeReference(d, { origin: "library", source_id: book, chunk_id: chunk });
  const three = drafts.citationsFor(d).find((r) => r.id === r3.id);
  check("a passage's page is taken from its chunk", three.locator === "p. 142" && three.text.endsWith("p. 142"), three.text);
}

// ---------------------------------------------------------------------------
section("Removing a reference takes its markers out of the saved draft");
// ---------------------------------------------------------------------------
{
  const d = drafts.createDraft("Remove");
  const s1 = source("One");
  const s2 = source("Two");
  const a = drafts.citeReference(d, { origin: "library", source_id: s1 }).id;
  const b = drafts.citeReference(d, { origin: "library", source_id: s2 }).id;
  drafts.saveDraft(d, { body_html: `<p>First${markerHtml(b)} then${markerHtml(a)} and${markerHtml(b)}</p>` });
  let html = drafts.getDraft(d).body_html;
  check("saved markers are numbered by first appearance", new RegExp(`data-cite="${b}"[^>]*>\\[1\\]`).test(html) && new RegExp(`data-cite="${a}"[^>]*>\\[2\\]`).test(html), html);
  check("and stay uneditable", (html.match(/contenteditable="false"/g) ?? []).length === 3, html);

  drafts.removeCitation(d, b);
  html = drafts.getDraft(d).body_html;
  check("both markers for the removed reference are gone", !html.includes(`data-cite="${b}"`), html);
  check("and the one left is now [1]", new RegExp(`data-cite="${a}"[^>]*>\\[1\\]`).test(html), html);
  check("the plain text follows", drafts.getDraft(d).body_md === "First then[1] and", JSON.stringify(drafts.getDraft(d).body_md));
}

// ---------------------------------------------------------------------------
section("Opening a draft repairs what the old rules left");
// ---------------------------------------------------------------------------
{
  const d = drafts.createDraft("Old");
  const s1 = source("Alpha", { outlet: "Alpha" });
  const s2 = source("Beta");
  const ins = db().prepare(
    "INSERT INTO draft_citations (draft_id, origin, text, source_id, locator, seq) VALUES (?, 'library', ?, ?, ?, ?)"
  );
  // Alpha listed twice — once through the shelf with a section heading as its
  // place — and Beta once; markers in the old shape, one with no id at all.
  const a1 = Number(ins.run(d, "Alpha, Alpha, Alpha", s1, null, 0).lastInsertRowid);
  const b1 = Number(ins.run(d, "Beta", s2, null, 1).lastInsertRowid);
  const a2 = Number(ins.run(d, "Alpha, Text", s1, "Text", 2).lastInsertRowid);
  db()
    .prepare("UPDATE drafts SET body_html=?, updated_at='2026-01-01 00:00:00' WHERE id=?")
    .run(
      `<p>One<span data-cite="${a2}" data-note="2">[3]</span> two<span data-note="1">[2]</span> three<span data-cite="${a1}" data-note="0">[1]</span></p>`,
      d
    );

  check("a repair reports that it changed something", drafts.repairCitations(d) === true);
  const list = drafts.citationsFor(d);
  const html = drafts.getDraft(d).body_html;
  check("the duplicate is merged into the first", list.length === 2 && !list.some((r) => r.id === a2), JSON.stringify(list.map((r) => r.id)));
  check("its markers now point at the survivor", !html.includes(`data-cite="${a2}"`) && citeOrder(html)[0] === a1, html);
  check("the marker with no id has one now", new RegExp(`two<span data-cite="${b1}"`).test(html), html);
  check("everything reads in order of first citation", /One<span[^>]*>\[1\][\s\S]*two<span[^>]*>\[2\][\s\S]*three<span[^>]*>\[1\]/.test(html), html);
  check("the reference text is re-read from the source", list.find((r) => r.id === a1).text === "Alpha", list.find((r) => r.id === a1).text);
  check("a repair is not an edit", drafts.getDraft(d).updated_at === "2026-01-01 00:00:00");
  check("and running it again changes nothing", drafts.repairCitations(d) === false);
}

// ---------------------------------------------------------------------------
section("The Word export follows the ids");
// ---------------------------------------------------------------------------
{
  const refs = [
    { id: 5, text: "Five" },
    { id: 9, text: "Nine" },
  ];
  // Stale indices, as an older save would have left them: the id must win.
  const { notes, blocks } = htmlToDocx(
    `<p>A<span data-cite="9" data-note="0">[1]</span> B<span data-cite="5" data-note="0">[2]</span> C<span data-cite="9" data-note="1">[1]</span></p>`,
    refs
  );
  check("footnotes are in order of first citation", notes.map((n) => n.text).join() === "Nine,Five", JSON.stringify(notes));
  check("a source cited twice is one footnote", blocks[0].runs.filter((r) => r.note === 0).length === 2);
  const legacy = htmlToDocx(`<p>A<span data-note="1">[2]</span></p>`, refs);
  check("a marker with only an index still finds its note", legacy.notes[0]?.text === "Nine");
  const orphan = htmlToDocx(`<p>A<span data-cite="77">[?]</span> b</p>`, refs);
  check("a marker for a missing reference exports nothing, not '[?]'", orphan.notes.length === 0 && !JSON.stringify(orphan.blocks).includes("[?]"));
}

// ---------------------------------------------------------------------------
section("A citation flattened to text is pointed out");
// ---------------------------------------------------------------------------
{
  const html = `<p>Cited${markerHtml(1, 1)} and flattened[6] and again [3].</p>`;
  check("bracketed numbers outside markers are found", strayBrackets(html).join() === "[6],[3]", strayBrackets(html).join());
  check("markers are not counted", strayBrackets(`<p>x${markerHtml(1, 1)}</p>`).length === 0);
}

// ---------------------------------------------------------------------------
section("formatCitation tidies what web pages hand it");
// ---------------------------------------------------------------------------
check(
  "a headline's '| CTech' goes when the outlet is ctech",
  formatCitation({ title: "Governor warns | CTech", outlet: "ctech" }) === "Governor warns, ctech"
);
check(
  "a dash in the middle of a headline stays",
  formatCitation({ title: "Israel - the year ahead", outlet: "Globes" }) === "Israel - the year ahead, Globes"
);
check("a byline's 'By' goes", formatCitation({ author: "By Lazar Berman", title: "T" }) === "Lazar Berman, T");

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
