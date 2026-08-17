/**
 * Quotes that cannot stand alone, names that can be linked, and the notebook.
 *
 * The deixis screen is the interesting one. It decides which quotes are worth
 * spending a resolution call on, and it is a heuristic, so it is tested against
 * the sentences that actually broke — "Immediately, Steve Bechtel knew he was
 * being rebuffed" — and against the ones that fooled earlier versions of it,
 * which are kept here as regressions rather than as trivia.
 *
 * Runs against a scratch database. No API key needed.
 *
 *   node scripts/test-context.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_context__");
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

const { needsContext, cueLabel } = await import("../lib/deixis.ts");
const { linkEntities } = await import("../lib/entity-links.ts");
const { db } = await import("../lib/db/index.ts");
const {
  createIdea,
  updateIdea,
  addPoint,
  updatePoint,
  movePoint,
  deletePoint,
  getIdea,
  listIdeas,
  draftFromIdea,
  deleteIdea,
} = await import("../lib/ideas.ts");
const { getDraft } = await import("../lib/drafts.ts");
const { passagesNeedingContext } = await import("../lib/pipeline/context.ts");

/* ------------------------------------------------------- the deixis screen */

section("Quotes that lean on something outside themselves");
{
  const needs = (q) => needsContext(q).needs;

  // The one that started it.
  check(
    "the Bechtel sentence is caught",
    needs("Immediately, Steve Bechtel knew he was being rebuffed."),
    JSON.stringify(needsContext("Immediately, Steve Bechtel knew he was being rebuffed."))
  );
  check(
    "and it is caught by its opener, not by its pronoun",
    needsContext("Immediately, Steve Bechtel knew he was being rebuffed.").cues.includes(
      "connective"
    )
  );

  check("a bare pronoun subject", needs("He understood the motivations for Zionism."));
  check(
    "a pronoun after an opening phrase",
    needs("Through persistence, he found a position working as a laborer."),
    "an adverbial in front changes nothing"
  );
  check("an opening demonstrative", needs("This attitude is summed up in the slogan."));
  check(
    "a demonstrative governed by a preposition",
    needs("After this initial meeting, serious negotiations did not continue until 1953.")
  );
  check(
    "a definite reference to something not introduced",
    needs("In the midst of the fiasco, Aramco was facing its own concerns.")
  );
  check(
    "a passive with nobody doing it",
    needs("The proposal was rejected within the week.")
  );
}

section("Quotes that stand perfectly well on their own");
{
  const needs = (q) => needsContext(q).needs;

  check(
    "a plain statement of fact",
    !needs("In June 1952, Sulaiman selected the Texas firm DeGolyer and MacNaughton.")
  );
  check(
    "a named subject doing something",
    !needs("Most of these projects were contracted to a San Francisco–based company called Bechtel.")
  );
  check(
    "a relative 'that' is not a demonstrative",
    !needs("Palestine already had an indigenous population that would never accept being superseded."),
    "this fired on a third of the library before the preposition rule"
  );
  check(
    "'Still others' opens a list, it does not refer back",
    !needs("Still others—such as ‘Isa al-‘Isa, the editor of Filastin—were exiled."),
    "the comma rule"
  );
  check(
    "a pronoun bound by a name earlier in the same quote",
    !needs("Herzl, the acknowledged leader of the movement he had founded, visited Palestine in 1898."),
    "a sentence-initial name still counts as a name"
  );
  check("an empty quote asks for nothing", !needs(""));
  check("punctuation alone asks for nothing", !needs("   “”   "));
}

section("Robustness");
{
  check(
    "a footnote number does not hide the opening word",
    needsContext("22 After this initial meeting, talks stopped.").needs,
    "PDF footnote markers land in the middle of the text"
  );
  check(
    "a leading quotation mark does not either",
    needsContext("“He was familiar with the pamphlet.”").needs
  );
  check("Arabic connectives are recognised", needsContext("ثم رفض الملك الاقتراح تماما.").needs);
  check("every cue has a plain-language label", ["connective", "pronoun", "demonstrative", "definite", "unnamed-agent"].every((c) => cueLabel(c).length > 5));
}

/* ---------------------------------------------------------- linking names */

section("Turning names in prose into links");
{
  const targets = [
    { id: 1, name: "Abdul Aziz", aliases: ["Ibn Saud", "Abdul Aziz ibn Saud"] },
    { id: 2, name: "Bechtel", aliases: [] },
    { id: 3, name: "Steve Bechtel", aliases: [] },
  ];

  const spans = linkEntities("Ibn Saud met Steve Bechtel about the Bechtel contract.", targets);
  const linked = spans.filter((s) => s.entityId !== undefined);
  check("an alias links to its entity", linked.some((s) => s.text === "Ibn Saud" && s.entityId === 1));
  check(
    "the longer name wins over the shorter one inside it",
    linked.some((s) => s.text === "Steve Bechtel" && s.entityId === 3),
    JSON.stringify(linked.map((l) => l.text))
  );
  check("the company still links on its own", linked.some((s) => s.text === "Bechtel" && s.entityId === 2));
  check(
    "the prose is preserved exactly",
    spans.map((s) => s.text).join("") === "Ibn Saud met Steve Bechtel about the Bechtel contract."
  );

  check(
    "a name inside a longer word is not linked",
    linkEntities("The Bechtels were a family.", targets)
      .filter((s) => s.entityId !== undefined)
      .every((s) => s.text !== "Bechtel"),
    "boundaries"
  );
  check("short names are left alone", linkEntities("He led it.", [{ id: 9, name: "He" }]).every((s) => s.entityId === undefined));
  check("no targets means no work", linkEntities("Anything at all.", []).length === 1);
  check("empty text is empty", linkEntities("", targets).length === 0);
}

/* -------------------------------------------------------------- the queue */

section("Choosing which passages to spend a call on");
{
  const src = Number(
    db().prepare("INSERT INTO sources (title, kind, status) VALUES ('Book','text','ready')").run()
      .lastInsertRowid
  );
  const chunk = (seq, text) =>
    Number(
      db()
        .prepare(
          "INSERT INTO chunks (source_id, seq, text, token_est, locator_json, extracted_at) VALUES (?,?,?,10,'{}',datetime('now'))"
        )
        .run(src, seq, text).lastInsertRowid
    );
  const ent = Number(
    db()
      .prepare("INSERT INTO entities (type, canonical_name, normalized) VALUES ('person','X','x')")
      .run().lastInsertRowid
  );
  const c1 = chunk(0, "a");
  const c2 = chunk(1, "b");
  const mention = (chunkId, quote, context = null) =>
    db()
      .prepare(
        "INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote, context, confidence) VALUES (?,?,?,'X',?,?,1)"
      )
      .run(ent, chunkId, src, quote, context);

  mention(c1, "Immediately, he refused.");
  mention(c1, "In 1952, Sulaiman selected the firm.");
  mention(c2, "This proposal was never put to the king.");
  mention(c2, "He had already left.", "the king's departure for Riyadh");

  const plan = passagesNeedingContext(src);
  check("only the quotes that need it are counted", plan.quotes === 2, `${plan.quotes}`);
  check("one call per passage, not per quote", plan.chunkIds.length === 2, `${plan.chunkIds.length}`);
  check("a quote that already has context is left alone", !plan.quotes || plan.quotes === 2);

  db().prepare("UPDATE mentions SET context='the 1951 meeting' WHERE quote LIKE 'Immediately%'").run();
  check("resolving one removes it from the queue", passagesNeedingContext(src).quotes === 1);

  db().prepare("UPDATE mentions SET discarded_at=datetime('now') WHERE quote LIKE 'This proposal%'").run();
  check(
    "evidence you discarded is not worth resolving",
    passagesNeedingContext(src).quotes === 0,
    `${passagesNeedingContext(src).quotes}`
  );
}

/* ------------------------------------------------------------- the notebook */

section("Ideas");
{
  const id = createIdea("The Bechtel fiasco", "Why did the Saudis break the contract?");
  check("an idea can be one sentence", getIdea(id).note.includes("Why did"));
  check("it starts as a seed", getIdea(id).state === "seed");

  updateIdea(id, { state: "developing", title: "Breaking Bechtel" });
  check("it can be retitled", getIdea(id).title === "Breaking Bechtel");
  check("and moved on", getIdea(id).state === "developing");

  const blank = createIdea();
  check("an untitled idea is still an idea", getIdea(blank).title === "Untitled");
  deleteIdea(blank);
  check("and can be dropped", getIdea(blank) === undefined);

  check("live work sorts above seeds", listIdeas()[0].id === id);
}

section("Outlines");
{
  const id = createIdea("Piece");
  const a = addPoint(id, "Background", 0);
  const b = addPoint(id, "The contract");
  const c = addPoint(id, "The break", 0);

  check("a new point inherits the level above it", getIdea(id).outline[1].depth === 0);

  updatePoint(b, { depth: 1 });
  check("it can be indented", getIdea(id).outline[1].depth === 1);
  updatePoint(b, { depth: 9 });
  check("but only so far", getIdea(id).outline[1].depth === 2, "two levels is the range");
  updatePoint(b, { depth: -3 });
  check("and not above the top", getIdea(id).outline[1].depth === 0);

  updatePoint(b, { depth: 1 });
  movePoint(c, -1);
  check(
    "points can be reordered",
    getIdea(id).outline.map((p) => p.text).join(",") === "Background,The break,The contract",
    getIdea(id).outline.map((p) => p.text).join(",")
  );

  movePoint(a, -1);
  check("the first point cannot move up past nothing", getIdea(id).outline[0].text === "Background");

  updatePoint(b, { quote: "…contracts could be broken…", citation: "Ex Libris, p. 88" });
  check("a point can carry the quote you already know you want", getIdea(id).outline[2].quote?.includes("contracts"));
  check("the evidence count follows", listIdeas().find((i) => i.id === id).evidenced === 1);

  deletePoint(a);
  check("a point can be removed", getIdea(id).outline.length === 2);
}

section("Becoming a draft");
{
  const id = createIdea("On the fiasco", "The argument in one line.");
  addPoint(id, "Background", 0);
  addPoint(id, "The Saudis had leverage", 1);
  updatePoint(getIdea(id).outline[1].id, { quote: "contracts could be broken", citation: "p. 88" });
  addPoint(id, "What followed", 0);

  const draftId = draftFromIdea(id);
  check("it produces a draft", typeof draftId === "number");

  const draft = getDraft(draftId);
  check("titled after the idea", draft.title === "On the fiasco");
  check("sections become headings", draft.body_html.includes("<h2>Background</h2>"));
  check("points become paragraphs", draft.body_html.includes("<p>The Saudis had leverage</p>"));
  check("quotes come across with their citation", draft.body_html.includes("contracts could be broken") && draft.body_html.includes("p. 88"));
  check("the plain text is filled in for the fact-check", draft.body_md.includes("Background"));

  const after = getIdea(id);
  check("the idea is marked as drafted", after.state === "drafted");
  check("and remembers what it became", after.draft_id === draftId);
  check("but is not consumed", after.outline.length === 3);

  check(
    "nothing was composed for you",
    !draft.body_md.toLowerCase().includes("in conclusion") &&
      draft.body_md.split(/\s+/).length < 30,
    "it is a skeleton, not prose"
  );
}

section("Nothing here calls a model");
{
  const src = fs.readFileSync(path.join(root, "lib", "ideas.ts"), "utf8");
  check("the notebook does not import the AI client", !src.includes("ai/client"));
  check("nor the queue", !src.includes("from \"./queue\""));
  const ui = fs.readFileSync(path.join(root, "app", "write", "Ideas.tsx"), "utf8");
  check("and neither does its page", !/generate|\/api\/ask|model/i.test(ui.replace(/model\b/gi, "")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
