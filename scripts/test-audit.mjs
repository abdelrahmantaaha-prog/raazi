/**
 * Discarding evidence by hand, and what that is supposed to guarantee.
 *
 * The claim this feature makes is unusually strong for something built on a
 * language model — that a passage you rejected cannot come back — so the claim
 * is what gets tested, against a real database and the real insert paths, rather
 * than the functions being spot-checked in isolation. Re-extraction destroying
 * and rebuilding every mention row is the case that matters, because that is
 * where a naive implementation keyed on mention id silently loses the verdict.
 *
 * Runs against a scratch database. No API key needed.
 *
 *   node scripts/test-audit.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_audit__");
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
  discardEvidence,
  restoreEvidence,
  discardsFor,
  libraryCorrections,
  forgetDiscard,
  discardIndex,
  isDiscarded,
  reapplyDiscards,
  correctionsFor,
  correctionsForSource,
  quoteKeyOf,
} = await import("../lib/audit.ts");
const { DISCARD_REASONS, reasonLabel, isReason } = await import("../lib/discard-reasons.ts");
const { persist } = await import("../lib/pipeline/extract.ts");
const { evidenceFor, discardedFor } = await import("../lib/queries.ts");
const { coverageOf, hashOf, mentionsFor, refreshState } = await import("../lib/pipeline/entry.ts");

/* ---------------------------------------------------------------- fixtures */

function makeSource(title) {
  return Number(
    db()
      .prepare("INSERT INTO sources (title, kind, status) VALUES (?, 'text', 'ready')")
      .run(title).lastInsertRowid
  );
}

function makeChunk(sourceId, seq, text) {
  return Number(
    db()
      .prepare(
        "INSERT INTO chunks (source_id, seq, text, token_est, locator_json, extracted_at) VALUES (?, ?, ?, 100, '{}', datetime('now'))"
      )
      .run(sourceId, seq, text).lastInsertRowid
  );
}

function makeEntity(name, normalized, type = "person") {
  const id = Number(
    db()
      .prepare(
        "INSERT INTO entities (type, canonical_name, normalized, entry_state) VALUES (?, ?, ?, 'none')"
      )
      .run(type, name, normalized).lastInsertRowid
  );
  db()
    .prepare("INSERT OR IGNORE INTO aliases (entity_id, surface, normalized) VALUES (?, ?, ?)")
    .run(id, name, normalized);
  return id;
}

function makeMention(entityId, chunkId, sourceId, surface, quote) {
  return Number(
    db()
      .prepare(
        "INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote, confidence) VALUES (?, ?, ?, ?, ?, 1.0)"
      )
      .run(entityId, chunkId, sourceId, surface, quote).lastInsertRowid
  );
}

/* ------------------------------------------------------------------ the key */

section("Recognising the same quote again");
{
  check("whitespace is collapsed", quoteKeyOf("a   b\n c") === "a b c");
  check("case is ignored", quoteKeyOf("The King") === quoteKeyOf("the king"));
  check("surrounding space is trimmed", quoteKeyOf("  x  ") === "x");
  check(
    "a quote re-wrapped across lines is the same quote",
    quoteKeyOf("He was\nborn in 1876.") === quoteKeyOf("He was born in 1876.")
  );
  check(
    "but a quote missing a word is not",
    quoteKeyOf("He was born in 1876.") !== quoteKeyOf("He was born.")
  );
}

section("The reason vocabulary");
{
  check("every reason has a label and a hint", DISCARD_REASONS.every((r) => r.label && r.hint));
  check(
    "every reason says something to the model",
    DISCARD_REASONS.every((r) => r.teaches && r.teaches.length > 40)
  );
  check("ids are unique", new Set(DISCARD_REASONS.map((r) => r.id)).size === DISCARD_REASONS.length);
  check("a known id is a reason", isReason("wrong-person"));
  check("an invented id is not", !isReason("because-i-said-so"));
  check("labels fall back rather than throwing", reasonLabel("nonsense") === "nonsense");
}

/* ------------------------------------------------------------- discarding */

section("Discarding one passage");
const src = makeSource("The Kingdom");
const c1 = makeChunk(src, 0, "Abdulaziz founded the state in 1932.");
const c2 = makeChunk(src, 1, "Abdulaziz, son of the finance minister, ran the ledger.");
const king = makeEntity("Abdulaziz", "abdulaziz");
const mGood = makeMention(king, c1, src, "Abdulaziz", "Abdulaziz founded the state in 1932.");
const mBad = makeMention(king, c2, src, "Abdulaziz", "Abdulaziz, son of the finance minister, ran the ledger.");

{
  db().prepare("UPDATE entities SET entry_state='fresh' WHERE id=?").run(king);

  const res = discardEvidence({
    mentionId: mBad,
    reason: "wrong-person",
    note: "This is Abdulaziz Sulaiman, the finance minister's son — not the king.",
  });
  check("the discard succeeds", res.ok === true);
  check("it reports which entry it changed", res.ok && res.entityId === king);

  const live = evidenceFor(king);
  check("the rejected passage leaves the evidence", live.length === 1, `${live.length} rows`);
  check("the good one stays", live[0]?.id === mGood);

  const gone = discardedFor(king);
  check("it is still readable, marked", gone.length === 1);
  check("with the reason attached", gone[0]?.discard_reason === "wrong-person");
  check("and your own words", (gone[0]?.note ?? "").includes("finance minister's son"));

  const state = db().prepare("SELECT entry_state FROM entities WHERE id=?").get(king);
  check("the entry is marked as needing a rewrite", state.entry_state === "stale");

  check("nothing was deleted", db().prepare("SELECT COUNT(*) AS n FROM mentions").get().n === 2);
}

section("What the rest of the pipeline sees");
{
  check("the entry writer is not given it", mentionsFor(king).every((m) => m.id !== mBad));
  check("the entry writer still gets the rest", mentionsFor(king).length === 1);

  // Built from exactly the evidence that survives the discard.
  db()
    .prepare(
      "INSERT INTO entries (entity_id, summary, body_md, built_from_hash) VALUES (?, '', ?, ?)"
    )
    .run(king, `He founded the state [[m:${mGood}]].`, hashOf([mGood]));
  const cov = coverageOf(king);
  check(
    "coverage counts only what still counts as evidence",
    cov.total === 1 && cov.cited === 1,
    `${cov.cited}/${cov.total}`
  );

  refreshState(king);
  const after = db().prepare("SELECT entry_state FROM entities WHERE id=?").get(king);
  check(
    "an entry citing everything left is fresh, not permanently stale",
    after.entry_state === "fresh",
    after.entry_state
  );
}

/* --------------------------------------------------- surviving re-extraction */

section("Surviving a re-extraction");
{
  // What re-extraction actually does: delete every mention for the source, then
  // write again from a fresh model response. The mention id the verdict was
  // given about no longer exists afterwards.
  db().prepare("DELETE FROM mentions WHERE source_id=?").run(src);
  check("the rows really are gone", db().prepare("SELECT COUNT(*) AS n FROM mentions").get().n === 0);

  const chunk = { id: c2, source_id: src, text: "Abdulaziz, son of the finance minister, ran the ledger." };
  persist(chunk, {
    entities: [
      {
        surface: "Abdulaziz",
        type: "person",
        quote: "Abdulaziz, son of the finance minister, ran the ledger.",
      },
    ],
    relations: [],
    events: [],
  });

  check(
    "the rejected passage is not written back",
    db().prepare("SELECT COUNT(*) AS n FROM mentions").get().n === 0,
    "it came back"
  );

  // And a passage you never rejected still lands, so the block is a scalpel
  // rather than a ban on the whole chunk.
  persist(
    { id: c1, source_id: src, text: "Abdulaziz founded the state in 1932." },
    {
      entities: [
        { surface: "Abdulaziz", type: "person", quote: "Abdulaziz founded the state in 1932." },
      ],
      relations: [],
      events: [],
    }
  );
  check("other evidence from the same source is unaffected", evidenceFor(king).length === 1);
}

section("Re-applying the ledger to rows that slipped through");
{
  // Rows written before the check existed, or by any path that forgets it.
  const sneaked = makeMention(
    king,
    c2,
    src,
    "Abdulaziz",
    "Abdulaziz,  son of the finance   minister, ran the ledger."
  );
  check("it is live to begin with", evidenceFor(king).some((e) => e.id === sneaked));

  const stamped = reapplyDiscards();
  check("re-applying catches it", stamped === 1, `stamped ${stamped}`);
  check("even though its whitespace differs", !evidenceFor(king).some((e) => e.id === sneaked));
  check(
    "and it carries the original reason",
    discardedFor(king).find((d) => d.id === sneaked)?.discard_reason === "wrong-person"
  );
}

/* ----------------------------------------------------------------- teaching */

section("What the model is told next time");
{
  const text = correctionsFor(king);
  check("the entry writer is given a corrections block", text.includes("STANDING CORRECTIONS"));
  check(
    "carrying the instruction for that reason",
    text.includes("A shared name is not identity")
  );
  check("and your words, quoted", text.includes("finance minister's son"));
  check(
    "the extractor is told about corrections raised against its source",
    correctionsForSource(src).includes("STANDING CORRECTIONS")
  );

  const other = makeSource("An unrelated book");
  check(
    "but an untouched source is told nothing",
    correctionsForSource(other) === "",
    correctionsForSource(other).slice(0, 60)
  );

  const clean = makeEntity("Nobody", "nobody");
  check("and so is an entry you have never corrected", correctionsFor(clean) === "");
}

section("Corrections stay short enough to be read");
{
  const noisy = makeEntity("Noisy", "noisy");
  const nc = makeChunk(src, 90, "filler");
  for (let i = 0; i < 20; i++) {
    const id = makeMention(noisy, nc, src, "Noisy", `Filler number ${i} about Noisy.`);
    discardEvidence({
      mentionId: id,
      reason: DISCARD_REASONS[i % DISCARD_REASONS.length].id,
      note: `note ${i}`,
    });
  }
  const text = correctionsFor(noisy);
  const bullets = text.split("\n").filter((l) => l.startsWith("- "));
  check("at most four reasons are shown", bullets.length <= 4, `${bullets.length} bullets`);
  const quoted = text.split("\n").filter((l) => l.includes("In their words"));
  check("with at most two examples each", quoted.length <= 8, `${quoted.length} quotes`);
  check(
    "the commonest mistake is reported with its count",
    /rejected \d+ times/.test(text),
    text.slice(0, 120)
  );
}

/* ------------------------------------------------------------------- undo */

section("Putting one back");
{
  // Not mBad: the re-extraction above destroyed that row, which is the whole
  // point of the ledger. What the button in the UI acts on is whatever is
  // currently marked — so that is what gets restored here too.
  const marked = discardedFor(king);
  check("there is a marked passage to restore", marked.length === 1, `${marked.length} marked`);

  const back = restoreEvidence(marked[0].id);
  check("restoring reports the entry", back.ok && back.entityId === king);
  check("the verdict is forgotten", !discardsFor(king).some((d) => d.quote.includes("ledger")));
  check("and the passage is evidence again", evidenceFor(king).some((e) => e.id === marked[0].id));

  // The row itself was deleted by the re-extraction above, so what matters is
  // that the ledger no longer blocks the quote coming back.
  const idx = discardIndex();
  check(
    "the same quote is no longer blocked",
    !isDiscarded(idx, "abdulaziz", "Abdulaziz, son of the finance minister, ran the ledger.")
  );

  // The exact quote, which was blocked a moment ago, now lands again.
  const before = evidenceFor(king).length;
  persist(
    { id: c2, source_id: src, text: "Abdulaziz, son of the finance minister, ran the ledger." },
    {
      entities: [
        {
          surface: "Abdulaziz",
          type: "person",
          quote: "Abdulaziz, son of the finance minister, ran the ledger.",
        },
      ],
      relations: [],
      events: [],
    }
  );
  check("and extraction writes it again", evidenceFor(king).length === before + 1);
}

section("Scope");
{
  const s2 = makeSource("Another book");
  const ch = makeChunk(s2, 0, "Someone said something.");
  const who = makeEntity("Someone", "someone");
  const m = makeMention(who, ch, s2, "Someone", "Someone said something.");
  discardEvidence({
    mentionId: m,
    reason: "trivial",
    note: "Stop collecting throat-clearing.",
    scope: "library",
  });

  check("a library-wide correction is recorded as such", libraryCorrections().length === 1);
  check(
    "and reaches a source it was never raised against",
    correctionsForSource(src).includes("throat-clearing")
  );
  check(
    "and an entry it was never raised on",
    correctionsFor(king).includes("throat-clearing")
  );

  const entityScoped = discardsFor(king).filter((d) => d.scope === "library");
  check("without being filed under that entry", entityScoped.length === 0);
}

section("Forgetting a verdict outright");
{
  const before = libraryCorrections();
  check("there is one to forget", before.length === 1);
  check("forgetting it succeeds", forgetDiscard(before[0].id));
  check("it is gone", libraryCorrections().length === 0);
  check(
    "and the passage it suppressed is live again",
    evidenceFor(before[0].entity_id).length === 1
  );
  check("forgetting a verdict that is not there is not an error", forgetDiscard(99999) === false);
}

section("Refusals");
{
  const bad = discardEvidence({ mentionId: 999999, reason: "trivial" });
  check("a missing passage is refused", bad.ok === false);
  const before = evidenceFor(king).length;
  const m = evidenceFor(king)[0];
  const wrong = discardEvidence({ mentionId: m.id, reason: "not-a-reason" });
  check("an invented reason is refused", wrong.ok === false);
  check("and it did not discard anything", evidenceFor(king).length === before);
}

/* ------------------------------------------------------------------ done */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
