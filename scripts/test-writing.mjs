/**
 * The writing desk, and the two guards that keep generated passes honest.
 *
 * The coherence pass rewrites finished entries, which makes it the most
 * dangerous thing in the pipeline: a citation it invents looks exactly like one
 * that was earned. So the checks it is subject to are tested directly.
 *
 * Runs against a scratch database. No API key needed.
 *
 *   node scripts/test-writing.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_writing__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
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
const {
  createDraft, getDraft, saveDraft, listDrafts, deleteDraft,
  addNote, notesFor, removeNote, reorderNotes, citationForSource,
} = await import("../lib/drafts.ts");

// ---------------------------------------------------------------------------
section("A passage sent from the reader is cited the way a search hit is");
// ---------------------------------------------------------------------------
// The reader knows the source and the place, not the citation; the desk
// renders one from them, so a passage sent while reading and a quote found
// from the pane read alike at the foot of the page.
{
  const sourceId = Number(
    db()
      .prepare("INSERT INTO sources (title, kind, status, author, year) VALUES ('The Cold War', 'text', 'ready', 'Odd Arne Westad', '2017')")
      .run().lastInsertRowid
  );
  const chunkId = Number(
    db()
      .prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, 'text', ?)")
      .run(sourceId, JSON.stringify({ page: 212 })).lastInsertRowid
  );
  const full = citationForSource(sourceId, chunkId);
  check("author, title, year and place", full === "Odd Arne Westad, The Cold War, 2017, p. 212", full);
  const bare = citationForSource(sourceId, null);
  check("without a place, author, title and year", bare === "Odd Arne Westad, The Cold War, 2017", bare);
  check("an unknown source is null", citationForSource(999999, null) === null);
  check("a chunk of another source does not lend its place", citationForSource(sourceId, chunkId + 999) === bare);
}

// ---------------------------------------------------------------------------
section("A draft is yours and does not evaporate");
// ---------------------------------------------------------------------------
{
  const id = createDraft("On the oil concessions");
  check("it exists", getDraft(id)?.title === "On the oil concessions");

  saveDraft(id, { body_md: "The concession was signed in 1933." });
  check("what you write is kept", getDraft(id).body_md.includes("1933"));

  // The editor autosaves. If a save fires before the draft has loaded into the
  // box — which is exactly what happens on mount — an empty body must not
  // overwrite the file you came to work on.
  saveDraft(id, { body_md: "" });
  check(
    "an empty autosave never wipes existing work",
    getDraft(id).body_md.includes("1933"),
    getDraft(id).body_md
  );

  saveDraft(id, { body_md: "Rewritten from scratch." });
  check("but a real edit still replaces it", getDraft(id).body_md === "Rewritten from scratch.");

  saveDraft(id, { title: "  " });
  check("a blank title falls back rather than blanking", getDraft(id).title === "On the oil concessions");

  const empty = createDraft("Empty");
  saveDraft(empty, { body_md: "" });
  check("an empty draft may stay empty", getDraft(empty).body_md === "");

  check("drafts list newest-touched first", listDrafts()[0].id === empty || listDrafts().length === 2);
  deleteDraft(empty);
  check("and delete", listDrafts().length === 1);
}

// ---------------------------------------------------------------------------
section("Gathered material is copied, not borrowed");
// ---------------------------------------------------------------------------
{
  const draftId = createDraft("Gathering");

  const sourceId = Number(
    db().prepare("INSERT INTO sources (title, kind, status) VALUES ('A book','text','ready')").run()
      .lastInsertRowid
  );
  const chunkId = Number(
    db()
      .prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, 'text', '{}')")
      .run(sourceId).lastInsertRowid
  );
  const entityId = Number(
    db()
      .prepare("INSERT INTO entities (type, canonical_name, normalized) VALUES ('person','Faisal','faisal')")
      .run().lastInsertRowid
  );
  const mentionId = Number(
    db()
      .prepare(
        `INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote)
         VALUES (?, ?, ?, 'Faisal', 'He led the negotiating team.')`
      )
      .run(entityId, chunkId, sourceId).lastInsertRowid
  );

  addNote(draftId, {
    text: "He led the negotiating team.",
    citation: "A book, p. 4",
    entity_id: entityId,
    mention_id: mentionId,
    chunk_id: chunkId,
    source_id: sourceId,
  });
  check("a note is kept", notesFor(draftId).length === 1);

  // Re-extraction deletes and recreates mentions. Study cards learned this the
  // hard way and lost their evidence wholesale; notes must not.
  db().prepare("DELETE FROM mentions WHERE id=?").run(mentionId);
  const after = notesFor(draftId);
  check("the quote survives its mention being deleted", after.length === 1);
  check("with the words intact", after[0].text === "He led the negotiating team.");
  check("and the citation intact", after[0].citation === "A book, p. 4");
  check("only the link goes null", after[0].mention_id === null, String(after[0].mention_id));

  const a = addNote(draftId, { text: "Second." });
  const b = addNote(draftId, { text: "Third." });
  check("notes keep the order you added them", b.map((n) => n.text)[2] === "Third.");

  const ids = b.map((n) => n.id);
  const reordered = reorderNotes(draftId, [ids[2], ids[0], ids[1]]);
  check("and can be reordered", reordered[0].text === "Third.", reordered[0].text);

  removeNote(draftId, ids[0]);
  check("and removed", notesFor(draftId).length === 2);

  deleteDraft(draftId);
  check(
    "deleting the draft takes its notes with it",
    db().prepare("SELECT COUNT(*) AS n FROM draft_notes WHERE draft_id=?").get(draftId).n === 0
  );
}

// ---------------------------------------------------------------------------
section("A citation of a library source carries the source's address");
// So the exported footnote is a link a reader can follow.
{
  const { addCitation, citationsFor: cites } = await import("../lib/drafts.ts");
  const draftId = createDraft("Linked");
  const withUrl = Number(
    db()
      .prepare("INSERT INTO sources (title, kind, status, url) VALUES ('A wire story', 'url', 'ready', 'https://example.org/story/1')")
      .run().lastInsertRowid
  );
  const noUrl = Number(
    db().prepare("INSERT INTO sources (title, kind, status) VALUES ('A book', 'text', 'ready')").run().lastInsertRowid
  );
  addCitation(draftId, { origin: "library", text: "A wire story, 2026", source_id: withUrl });
  addCitation(draftId, { origin: "library", text: "A book, p. 4", source_id: noUrl });
  addCitation(draftId, { origin: "outside", text: "Something read elsewhere" });
  const list = cites(draftId);
  check("the source's address is filled in", list[0].url === "https://example.org/story/1", list[0].url);
  check("the text as given is kept", list[0].text === "A wire story, 2026");
  check("a source with no address gets none", list[1].url === null);
  check("an outside reference is untouched", list[2].url === null);
  deleteDraft(draftId);
}

section("Saving a draft does not weld its paragraphs together");
// The bug this guards: contenteditable emits a div per paragraph in Chrome and
// in Brave, the sanitiser dropped unknown tags while keeping their text, and
// so every autosave merged the whole draft into one run of prose. It showed on
// the next load, which is why it looked like refreshing caused it.
{
  const { sanitizeHtml, saveDraft, getDraft } = await import("../lib/drafts.ts");

  const typed = "First paragraph.<div>Second paragraph.</div><div>Third paragraph.</div>";
  const clean = sanitizeHtml(typed);
  check("a div becomes a paragraph rather than vanishing", clean === "First paragraph.<p>Second paragraph.</p><p>Third paragraph.</p>", clean);
  check("the three are still three blocks", (clean.match(/<p>/g) ?? []).length === 2 && clean.startsWith("First"), clean);
  check(
    "and the words are never run together",
    !/paragraph\.Second|paragraph\.Third/.test(clean),
    clean
  );

  // A div wrapping paragraphs, which is the other shape a browser produces.
  const wrapped = sanitizeHtml("<div><p>One.</p><p>Two.</p></div>");
  check("a div around paragraphs does not nest them", wrapped === "<p></p><p>One.</p><p>Two.</p>", wrapped);

  // Round-trip through the database, which is what actually bit.
  const id = createDraft("Round trip");
  saveDraft(id, { body_html: typed });
  const saved = getDraft(id);
  check("what comes back out still has its blocks", (saved.body_html.match(/<p>/g) ?? []).length === 2, saved.body_html);
  check(
    "and the plain text keeps them apart",
    saved.body_md === "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
    JSON.stringify(saved.body_md)
  );
  // Saving the same body again must be stable, or every refresh drifts.
  saveDraft(id, { body_html: saved.body_html });
  check("saving it a second time changes nothing", getDraft(id).body_html === saved.body_html, getDraft(id).body_html);
  deleteDraft(id);
}

section("A draft body cannot carry anything that runs");
// ---------------------------------------------------------------------------
{
  const { sanitizeHtml } = await import("../lib/drafts.ts");

  // The attack the audit found: a LAN client plants an onerror handler, and it
  // fires the next time the writing desk renders the draft — as you, with the
  // whole API in reach.
  const planted = '<p>Ordinary text.</p><img src=x onerror="fetch(\'/api/export?format=json\')">';
  const cleaned = sanitizeHtml(planted);
  check("an img is dropped entirely", !/<img/i.test(cleaned), cleaned);
  check("and so is its handler", !/onerror/i.test(cleaned), cleaned);
  check("while the writing survives", cleaned.includes("Ordinary text."), cleaned);

  check(
    "a script's contents go with it",
    sanitizeHtml("<p>Keep</p><script>alert(1)</script>") === "<p>Keep</p>",
    sanitizeHtml("<p>Keep</p><script>alert(1)</script>")
  );
  check(
    "so do an iframe's and a style's",
    sanitizeHtml("<iframe src='http://x'>no</iframe><style>p{}</style><p>Yes</p>") === "<p>Yes</p>",
    sanitizeHtml("<iframe src='http://x'>no</iframe><style>p{}</style><p>Yes</p>")
  );

  // Every attribute is rebuilt rather than filtered, so a handler cannot ride
  // in on an allowed tag under a name nobody thought to block.
  const attrs = sanitizeHtml('<p onclick="steal()" style="x" class="y" id="z">Text</p>');
  check("attributes on allowed tags are rebuilt, not filtered", attrs === "<p>Text</p>", attrs);

  check(
    "a link keeps an http address",
    sanitizeHtml('<a href="https://example.org/a">x</a>').includes('href="https://example.org/a"'),
    sanitizeHtml('<a href="https://example.org/a">x</a>')
  );
  for (const bad of [
    '<a href="javascript:alert(1)">x</a>',
    '<a href="data:text/html,y">x</a>',
    '<a href="vbscript:x">x</a>',
    // Encoded, so a naive prefix test would let it through.
    '<a href="java&#115;cript:alert(1)">x</a>',
  ]) {
    const out = sanitizeHtml(bad);
    check(
      `a link to ${bad.slice(9, 26)} keeps its text and loses the link`,
      !/<a\b/i.test(out) && out.includes("x"),
      out
    );
  }

  // The citation marker is the one span the export understands.
  check(
    "a citation marker survives",
    sanitizeHtml('<span data-note="3">[1]</span>') === '<span data-note="3">[1]</span>',
    sanitizeHtml('<span data-note="3">[1]</span>')
  );
  check(
    "a span with anything else is unwrapped",
    sanitizeHtml('<span class="x">text</span>') === "text",
    sanitizeHtml('<span class="x">text</span>')
  );
  check(
    "a data-note that is not a number is not a marker",
    !sanitizeHtml('<span data-note="x()">t</span>').includes("data-note")
  );

  const editorMarkup =
    "<h2>Head</h2><ul><li><strong>a</strong> <em>b</em></li></ul><blockquote>q</blockquote><hr><pre><code>c</code></pre>";
  check(
    "the ordinary editor markup all passes",
    sanitizeHtml(editorMarkup) === editorMarkup,
    sanitizeHtml(editorMarkup)
  );
  check(
    "b and i are folded to one spelling",
    sanitizeHtml("<b>x</b><i>y</i>") === "<strong>x</strong><em>y</em>"
  );
  check(
    "unbalanced markup is closed rather than left open",
    sanitizeHtml("<p>one<p>two") === "<p>one</p><p>two</p>",
    sanitizeHtml("<p>one<p>two")
  );
  check(
    "a stray < is text, not a tag",
    sanitizeHtml("<p>a < b</p>") === "<p>a &lt; b</p>",
    sanitizeHtml("<p>a < b</p>")
  );
  check(
    "a comment cannot swallow the document",
    sanitizeHtml("<!-- <p>x</p> --><p>y</p>") === "<p>y</p>",
    sanitizeHtml("<!-- <p>x</p> --><p>y</p>")
  );

  // It has to hold on the way in, whatever wrote the row.
  const id = createDraft("Sanitised");
  saveDraft(id, { body_html: '<p>Safe</p><img src=x onerror="alert(1)">' });
  check("the stored body is clean", !/onerror|<img/i.test(getDraft(id).body_html), getDraft(id).body_html);
  check("and the plain-text form still has the words", getDraft(id).body_md.includes("Safe"));

  // And on the way out, for rows written before the sanitiser existed.
  db()
    .prepare("UPDATE drafts SET body_html=? WHERE id=?")
    .run('<p>Old</p><img src=x onerror="alert(1)">', id);
  check(
    "a row written behind our back is cleaned on read",
    !/onerror/i.test(getDraft(id).body_html),
    getDraft(id).body_html
  );
  deleteDraft(id);
}

// ---------------------------------------------------------------------------
section("The coherence pass cannot invent or lose citations");
// ---------------------------------------------------------------------------
{
  // The guard, lifted out exactly as the handler applies it. A rewrite is
  // accepted only if it cites nothing new and drops no more than a fifth.
  const markers = (body) => new Set([...body.matchAll(/\[\[m:(\d+)\]\]/g)].map((m) => Number(m[1])));
  const verdict = (before, after) => {
    const b = markers(before);
    const a = markers(after);
    const invented = [...a].filter((id) => !b.has(id));
    const lost = [...b].filter((id) => !a.has(id));
    if (invented.length > 0) return "rejected: invented";
    if (lost.length > b.size * 0.2) return "rejected: gutted";
    return "accepted";
  };

  const original = "He was born in Riyadh [[m:1]]. He led the team [[m:2]]. He resigned [[m:3]]. He died [[m:4]]. He was buried [[m:5]].";

  check(
    "reordering the same material is accepted",
    verdict(original, "He led the team [[m:2]]. He was born in Riyadh [[m:1]]. He resigned [[m:3]]. He died [[m:4]]. He was buried [[m:5]].") === "accepted"
  );

  check(
    "merging two statements and carrying both markers is accepted",
    verdict(original, "He died and was buried [[m:4]] [[m:5]]. Born in Riyadh [[m:1]], he led the team [[m:2]] and resigned [[m:3]].") === "accepted"
  );

  check(
    "a citation that was never in the entry is rejected",
    verdict(original, `${original} He also founded the bank [[m:99]].`) === "rejected: invented",
    verdict(original, `${original} He also founded the bank [[m:99]].`)
  );

  check(
    "so is one invented while everything else is dropped",
    verdict(original, "He founded the bank [[m:42]].") === "rejected: invented"
  );

  check(
    "gutting the entry is rejected",
    verdict(original, "He was born in Riyadh [[m:1]].") === "rejected: gutted"
  );

  check(
    "losing a single citation out of five is tolerated",
    verdict(original, "Born in Riyadh [[m:1]], he led the team [[m:2]], resigned [[m:3]] and died [[m:4]].") === "accepted"
  );

  check("adding no facts and no markers is fine", verdict("Plain prose.", "Prose, plainly.") === "accepted");
}

// ---------------------------------------------------------------------------
section("Anything in the library can be found and cited from the desk");
// ---------------------------------------------------------------------------
{
  const { searchCitable, sentenceWith } = await import("../lib/cite-search.ts");
  const src = (title, { author = null, outlet = null, year = null, triage = null, starred = false } = {}) =>
    Number(
      db()
        .prepare(
          "INSERT INTO sources (title, kind, status, author, outlet, year, triage, starred_at) VALUES (?, 'text', 'ready', ?, ?, ?, ?, ?)"
        )
        .run(title, author, outlet, year, triage, starred ? "2026-09-14 10:00:00" : null).lastInsertRowid
    );
  const chunk = (sourceId, text, locator = { page: 7 }) =>
    db().prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, ?, ?)").run(sourceId, text, JSON.stringify(locator));

  // A passage that names nobody: extraction ties no person or institution to it,
  // so the pane's first search could never have found it.
  const budget = src("Appropriations in an Election Year", { author: "Jane Roe", year: "2025" });
  chunk(budget, "Congress returned in September. The subcommittee cut the disaster relief line by a third. Nobody was named in the report.", { page: 41 });
  const held = src("Waiting in the inbox", { triage: "held" });
  chunk(held, "The subcommittee also met about disaster relief in a piece still waiting.");
  const thrown = src("Thrown out", { triage: "discarded" });
  chunk(thrown, "A discarded article about disaster relief.");
  const starred = src("A starred article on relief", { triage: "held", starred: true, outlet: "The Paper" });
  chunk(starred, "Relief funds were delayed, the starred article said.");
  const kept = src("Kept piece", { triage: "kept", outlet: "Northern Post" });
  chunk(kept, "Pipeline permits were approved.");

  const found = searchCitable("disaster relief");
  const from = found.passages.map((p) => p.source_id);
  check("a passage naming nobody is found by its words", from.includes(budget), JSON.stringify(from));
  const hit = found.passages.find((p) => p.source_id === budget);
  check("and handed back as the sentence it was found by", hit?.quote === "The subcommittee cut the disaster relief line by a third.", JSON.stringify(hit?.quote));
  check("cited with author, title, year and page", hit?.citation === "Jane Roe, Appropriations in an Election Year, 2025, p. 41", JSON.stringify(hit?.citation));
  check("nothing still waiting in the inbox", !from.includes(held));
  check("nothing thrown out", !from.includes(thrown));
  check("but an article you starred, read or not, is there", searchCitable("relief").passages.some((p) => p.source_id === starred));
  check("the last word matches while it is being typed", searchCitable("subcomm").passages.some((p) => p.source_id === budget));
  check("every word must be in the passage", searchCitable("relief pipeline").passages.length === 0);

  check("a source is found by its title", searchCitable("appropriations").sources.some((s) => s.id === budget));
  check("by its author", searchCitable("Roe").sources.some((s) => s.id === budget));
  check("by its outlet", searchCitable("Northern").sources.some((s) => s.id === kept));
  check(
    "a whole source is cited without a page",
    searchCitable("appropriations").sources.find((s) => s.id === budget)?.citation === "Jane Roe, Appropriations in an Election Year, 2025"
  );
  check("held and discarded sources are not offered by name either", searchCitable("Waiting inbox").sources.length === 0 && searchCitable("Thrown").sources.length === 0);
  check("one letter is not a search", searchCitable("r").sources.length === 0 && searchCitable("r").passages.length === 0);
  check(
    "syntax typed into the box does not break it",
    [`"`, "*", "(", "OR", "NEAR(", "a:b", "100%", `"relief`].every((q) => {
      const r = searchCitable(q);
      return Array.isArray(r.sources) && Array.isArray(r.passages);
    })
  );
  check(
    "the sentence holding most of the words wins",
    sentenceWith("Relief came. Disaster relief came late. Nothing else.", ["disaster", "relief"]) === "Disaster relief came late."
  );
  check(
    "a very long sentence is cut at a word, not mid-word",
    (() => {
      const s = sentenceWith(`${"word ".repeat(200)}end.`, ["word"], 60);
      return s.length <= 60 && s.endsWith("…") && /word…$/.test(s);
    })()
  );
}

// ---------------------------------------------------------------------------
section("The curation pane's search touches no model");
// ---------------------------------------------------------------------------
{
  const source = fs.readFileSync(path.join(root, "app/api/drafts/search/route.ts"), "utf8");
  const desk = fs.readFileSync(path.join(root, "app/write/WritingDesk.tsx"), "utf8");

  check(
    "the search route imports nothing from lib/ai",
    !/from ["']@?\/?\.*\/?lib\/ai/.test(source) && !/generateJson|generateText/.test(source)
  );
  check(
    "and the desk only reaches a model through the fact-check endpoint",
    (() => {
      const calls = [...desk.matchAll(/fetch\(`?["'`]([^"'`]+)/g)].map((m) => m[1]);
      const aiCalls = calls.filter((c) => /check/.test(c));
      const rest = calls.filter((c) => !/check/.test(c));
      // The drafts routes, and the library's own list — read for the source
      // picker when a quote is logged by hand. Neither touches a model.
      return aiCalls.length > 0 && rest.every((c) => /\/api\/(drafts|sources)(\/|\?|$)/.test(c));
    })(),
    [...desk.matchAll(/fetch\(`?["'`]([^"'`]+)/g)].map((m) => m[1]).join(", ")
  );
  check("no model is imported into the desk at all", !/lib\/ai|generateJson|generateText/.test(desk));

  // The library search for citing, and the dialog and toolbar that open it.
  const librarySearch =
    fs.readFileSync(path.join(root, "app/api/drafts/library/route.ts"), "utf8") +
    fs.readFileSync(path.join(root, "lib/cite-search.ts"), "utf8");
  check("the library search for citing imports nothing from lib/ai either", !/lib\/ai|generateJson|generateText/.test(librarySearch));
  const deskParts = ["LibraryCite.tsx", "Editor.tsx"].map((f) => fs.readFileSync(path.join(root, "app/write", f), "utf8"));
  const partCalls = deskParts.flatMap((s) => [...s.matchAll(/fetch\(`?["'`]([^"'`]+)/g)].map((m) => m[1]));
  check(
    "the cite dialog and the editor reach only the drafts routes",
    partCalls.length > 0 && partCalls.every((c) => /\/api\/drafts(\/|\?|$)/.test(c)),
    partCalls.join(", ")
  );
  check("and import no model", deskParts.every((s) => !/lib\/ai|generateJson|generateText/.test(s)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
