/**
 * Expanding a heading of the brief.
 *
 * The properties: a heading's section is read the way the page draws it,
 * subsections included; an expansion is written from the passages cited
 * there, the rest of those articles, and earlier coverage that genuinely
 * shares the subject — never from something held, discarded, out of the
 * window, or connected only by a subject every article mentions; and a marker
 * the writer was not shown does not survive.
 *
 * No model is called. The writing call is the one untested line.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-expand.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_expand__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.env.CORPUS_DATA_DIR = SANDBOX;
process.env.CORPUS_WORKER_IDLE_MS = "150";

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
const same = (a, b) => JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));

const { db } = await import("../lib/db/index.ts");
const sections = await import("../lib/brief-sections.ts");
const expansions = await import("../lib/expansions.ts");
const expand = await import("../lib/pipeline/expand.ts");
const { blocks } = await import("../lib/md-blocks.ts");

const now = Date.now();
const iso = (daysAgo) => new Date(now - daysAgo * 86_400_000).toISOString();

const entity = (name) =>
  Number(
    db()
      .prepare("INSERT INTO entities (type, canonical_name, normalized) VALUES ('institution', ?, ?)")
      .run(name, name.toLowerCase()).lastInsertRowid
  );
const source = (title, { daysAgo = 0, triage = "kept", outlet = "The Paper" } = {}) => {
  const id = Number(
    db()
      .prepare(
        "INSERT INTO sources (title, kind, url, status, triage, outlet, published_at, kept_at) VALUES (?, 'url', ?, 'chunked', ?, ?, ?, ?)"
      )
      .run(title, `https://paper.example/${encodeURIComponent(title)}`, triage, outlet, iso(daysAgo), triage === "kept" ? iso(daysAgo) : null)
      .lastInsertRowid
  );
  const chunk = Number(
    db().prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, 'text', '{}')").run(id).lastInsertRowid
  );
  return { id, chunk };
};
const mention = (src, entityId, quote) =>
  Number(
    db()
      .prepare("INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote, claim) VALUES (?, ?, ?, 'x', ?, 'a claim')")
      .run(entityId, src.chunk, src.id, quote).lastInsertRowid
  );

// --- A small library --------------------------------------------------------
const board = entity("Tariff Review Board"); // rare: the subject of the section
const canada = entity("Canada");
const us = entity("United States"); // in everything
const weather = entity("Weather Service"); // unrelated to the section

const A = source("Board meets on tariffs");
const B = source("Canada responds");
const a1 = mention(A, board, "The board met on Tuesday.");
const a2 = mention(A, canada, "Ottawa was consulted.");
const a3 = mention(A, board, "The board will report in October."); // same article, not cited
const b1 = mention(B, canada, "Canada said it would respond.");
const b2 = mention(B, us, "Washington welcomed the review.");

const C = source("The board is created", { daysAgo: 10 });
const c1 = mention(C, board, "The board was created last month.");
const c2 = mention(C, weather, "Storms are forecast."); // off the subject

const D = source("Discarded board story", { daysAgo: 10, triage: "discarded" });
const d1 = mention(D, board, "A discarded mention of the board.");
const E = source("Old board story", { daysAgo: 90 });
const e1 = mention(E, board, "Too long ago to count.");
const F = source("Only about Washington", { daysAgo: 5 });
const f1 = mention(F, us, "Washington did something unrelated.");

// A running story the cited article belongs to, whose other account shares no subject.
const G = source("Another account of the meeting", { daysAgo: 3 });
const g1 = mention(G, weather, "The meeting went ahead despite the weather.");
const story = Number(db().prepare("INSERT INTO stories (title, first_seen, last_seen) VALUES ('Board meets', ?, ?)").run(iso(3), iso(0)).lastInsertRowid);
db().prepare("INSERT INTO story_sources (story_id, source_id) VALUES (?, ?), (?, ?)").run(story, A.id, story, G.id);

// Forty articles that mention nothing but the United States.
for (let i = 0; i < 40; i++) mention(source(`Filler ${i}`, { daysAgo: 1 + (i % 30) }), us, `Filler ${i}.`);

const day = "2026-09-14";
const body = `**The board met.**

## On your beat

### Trade policy

The board met [[m:${a1}]] and Ottawa was consulted [[m:${a2}]] [[m:${b1}]].

Washington welcomed it [[m:${b2}]].

### Elections

Nothing cited here.

## Worth chasing

- What will the board report?`;
db()
  .prepare("INSERT INTO briefs (day, kind, state, body_md, window_from, window_to) VALUES (?, 'day', 'done', ?, ?, ?)")
  .run(day, body, iso(1), iso(0));

section("A brief is read as sections, the way the page draws it");
{
  const list = sections.briefSections(body);
  check("every heading is found, in order", JSON.stringify(list.map((s) => s.heading)) === JSON.stringify(["On your beat", "Trade policy", "Elections", "Worth chasing"]), JSON.stringify(list.map((s) => s.heading)));
  const trade = list.find((s) => s.heading === "Trade policy");
  check("a section carries the passages cited under it", same(trade.mentionIds, [a1, a2, b1, b2]), JSON.stringify(trade.mentionIds));
  check("a section's subsections belong to it", same(list[0].mentionIds, [a1, a2, b1, b2]));
  check("a section ends at the next heading of its level", list.find((s) => s.heading === "Elections").mentionIds.length === 0);
  check("a list with no citations has nothing to expand", list.find((s) => s.heading === "Worth chasing").mentionIds.length === 0);
  check("a heading's key drops emphasis and markers", sections.headingKey("**Trade** policy [[m:3]]") === "Trade policy");
  check("the block grammar is the one the page uses", blocks(body).filter((b) => b.kind === "h").length === 4);
}

section("An expansion is written from the right passages");
{
  const m = expansions.expansionMaterial(day, "Trade policy");
  check("it finds the heading", Boolean(m));
  check("the cited passages are the ones cited", same(m.cited.map((p) => p.mention_id), [a1, a2, b1, b2]));
  check("the rest of a cited article comes too", m.articles.some((p) => p.mention_id === a3) && !m.articles.some((p) => p.mention_id === a1));

  const bg = m.background.map((p) => p.mention_id);
  check("earlier coverage sharing a rare subject is background", bg.includes(c1), JSON.stringify(bg));
  check("but only its passages about the subject", !bg.includes(c2));
  check("another account in the same running story is background", bg.includes(g1));
  check("nothing discarded", !bg.includes(d1));
  check("nothing from before the lookback", !bg.includes(e1));
  check("nothing connected only by a subject everything mentions", !bg.includes(f1) && m.counts.backgroundSources === 2, JSON.stringify(m.counts));
  check("background runs oldest first", bg.indexOf(c1) < bg.indexOf(g1));

  check("rarity is relative to the library: fifty in three thousand counts alone", expansions.rarity(50, 3000) >= expansions.EXPAND_MIN_SCORE, String(expansions.rarity(50, 3000)));
  check("a subject in half the library does not", expansions.rarity(1500, 3000) < 0.1, String(expansions.rarity(1500, 3000)));
  check("nor do three of them together", 3 * expansions.rarity(1500, 3000) < expansions.EXPAND_MIN_SCORE);
  check("a subject in one article of many is as rare as it gets", expansions.rarity(1, 3000) > 0.9);

  check("a heading not in the brief has no material", expansions.expansionMaterial(day, "Iran") === undefined);
  check("nor one with nothing cited", expansions.expansionMaterial(day, "Elections") === undefined);

  const parts = expand.expandParts(m);
  const prompt = parts.join("\n\n");
  check("the writer is told the topic", prompt.includes('TOPIC: "Trade policy"'));
  check("and shown every passage with its marker", prompt.includes(`[[m:${a3}]]`) && prompt.includes(`[[m:${c1}]]`) && prompt.includes("The board was created last month."));
  check("every marker it was shown is valid, and nothing else", same(expand.validMarkers(m), [a1, a2, b1, b2, a3, c1, g1]));
}

section("What comes back is guarded like the brief");
{
  const valid = new Set([1, 2]);
  const out = expand.composeExpansion({ body: "It stands [[m:1]], and a guess [[m:999]]. Both [[m:1], [m:2]].", questions: [" Who pays? ", ""] }, valid);
  check("a marker it was not shown is removed", !out.includes("999"));
  check("the ones it was shown are kept and normalised", out.includes("[[m:1]] [[m:2]]"));
  check("questions are listed at the end, without citations", /#### Worth finding out\n\n- Who pays\?$/.test(out), JSON.stringify(out));
  check("an empty answer stores nothing", expand.composeExpansion({ body: "   " }, valid) === "");
}

section("Asking for one");
{
  let refused = null;
  try {
    expansions.requestExpansion(day, "Elections");
  } catch (err) {
    refused = err;
  }
  check("a heading with nothing cited is refused, in words", refused instanceof expansions.ExpandError && /nothing to expand/.test(refused.message));
  let missing = null;
  try {
    expansions.requestExpansion(day, "Iran");
  } catch (err) {
    missing = err;
  }
  check("so is one that is not in the brief", missing instanceof expansions.ExpandError);

  const first = expansions.requestExpansion(day, "**Trade policy**");
  check("it queues a run and a pending row", first.runId > 0 && first.expansion.state === "pending" && first.expansion.heading === "Trade policy");
  const task = db().prepare("SELECT * FROM tasks WHERE run_id=?").get(first.runId);
  check("the task is an expand task naming the row", task.kind === "expand" && JSON.parse(task.payload_json).expansionId === first.expansion.id);
  check("the listing shows the run writing it", expansions.listExpansions(day)[0].run_id === first.runId);

  db().prepare("UPDATE brief_expansions SET state='done', body_md='Done [[m:1]].' WHERE id=?").run(first.expansion.id);
  db().prepare("UPDATE tasks SET state='done' WHERE id=?").run(task.id);
  const again = expansions.requestExpansion(day, "Trade policy");
  check("one already written is returned, not rewritten", again.runId === null && again.note && again.expansion.state === "done");
  const forced = expansions.requestExpansion(day, "Trade policy", { force: true });
  check("unless asked to write it again", forced.runId > 0 && forced.expansion.state === "pending" && forced.expansion.id === first.expansion.id);
  check("still one row per heading", db().prepare("SELECT COUNT(*) AS n FROM brief_expansions").get().n === 1);

  // The brief is rewritten without the heading before the task runs.
  db().prepare("UPDATE briefs SET body_md=? WHERE day=?").run("## Something else\n\nText [[m:1]].", day);
  const queued = db().prepare("SELECT * FROM tasks WHERE run_id=?").get(forced.runId);
  await expand.handleExpand(queued);
  const row = expansions.getExpansion(first.expansion.id);
  check("a heading gone from a rewritten brief fails the row, saying why", row.state === "failed" && /rewritten/.test(row.error ?? ""), JSON.stringify(row));
  check("and the task is skipped rather than retried", db().prepare("SELECT state FROM tasks WHERE id=?").get(queued.id).state === "skipped");
}

console.log(`\n${passed} passed, ${failed} failed`);
db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
