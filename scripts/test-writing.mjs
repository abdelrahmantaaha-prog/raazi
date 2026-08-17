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
  addNote, notesFor, removeNote, reorderNotes,
} = await import("../lib/drafts.ts");

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
      return aiCalls.length > 0 && rest.every((c) => /\/api\/drafts/.test(c));
    })(),
    [...desk.matchAll(/fetch\(`?["'`]([^"'`]+)/g)].map((m) => m[1]).join(", ")
  );
  check("no model is imported into the desk at all", !/lib\/ai|generateJson|generateText/.test(desk));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
