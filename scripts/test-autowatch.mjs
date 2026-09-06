/**
 * The watchlist that learns from what you keep — as topics.
 *
 * The properties worth protecting: it counts what you decided to keep and not
 * what merely arrived, a topic one outlet uses is not a beat, a suggestion you
 * decline never comes back, and the brief never prints one passage twice.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-autowatch.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const SANDBOX = path.join(root, "data", "__test_autowatch__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.env.CORPUS_DATA_DIR = SANDBOX;

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};
const section = (t) => console.log(`\n${t}`);

const { db } = await import("../lib/db/index.ts");
const { normalize } = await import("../lib/normalize.ts");
const wl = await import("../lib/watchlist.ts");
const brief = await import("../lib/brief.ts");

function tag(name) {
  return Number(db().prepare("INSERT INTO tags (name) VALUES (?)").run(name).lastInsertRowid);
}
function entity(name, type = "person") {
  return Number(
    db().prepare("INSERT INTO entities (canonical_name, normalized, type) VALUES (?, ?, ?)")
      .run(name, normalize(name), type).lastInsertRowid
  );
}
/** A kept source from an outlet, filed under tags, mentioning entities. */
function source(outlet, triage, tagIds, entityIds) {
  const sid = Number(
    db().prepare(
      "INSERT INTO sources (title, kind, status, outlet, triage, kept_at) VALUES (?, 'url', 'ready', ?, ?, datetime('now'))"
    ).run(`Piece from ${outlet}`, outlet, triage).lastInsertRowid
  );
  const cid = Number(
    db().prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, 'text', '{}')").run(sid).lastInsertRowid
  );
  for (const t of tagIds) db().prepare("INSERT INTO source_tags (source_id, tag_id) VALUES (?, ?)").run(sid, t);
  for (const e of entityIds) {
    db().prepare(
      "INSERT INTO mentions (entity_id, source_id, chunk_id, surface, quote, claim) VALUES (?, ?, ?, 's', 'q', 'c')"
    ).run(e, sid, cid);
  }
  return sid;
}

const politics = tag("US Politics");
const trade = tag("Trade policy");
const niche = tag("One outlet's hobby horse");

// The president is four entities in every article — the repetition the topic
// model exists to remove.
const trump = entity("Donald Trump");
const admin = entity("Trump administration", "institution");
const house = entity("White House", "institution");
const usa = entity("United States", "place");

for (const outlet of ["CBC", "Politico", "NPR", "The Hill"]) {
  source(outlet, "kept", [politics], [trump, admin, house, usa]);
}
for (const outlet of ["Axios", "Reuters", "BBC News", "The Hill"]) {
  source(outlet, "kept", [trade], [trump, usa]);
}
// One outlet writing about its own preoccupation is not a beat.
for (let i = 0; i < 5; i++) source("The Hill", "kept", [niche], [trump]);
// And a discarded pile that would otherwise dominate.
const dropped = tag("Discarded topic");
for (const outlet of ["CBC", "Politico", "NPR", "Axios", "BBC News"]) {
  source(outlet, "discarded", [dropped], [trump]);
}

section("What earns a place");
{
  const names = wl.suggestions().map((s) => s.name);
  check("a topic several outlets cover is suggested", names.includes("US Politics"), JSON.stringify(names));
  check("so is a second one", names.includes("Trade policy"));
  check("one outlet's preoccupation is not", !names.includes("One outlet's hobby horse"), JSON.stringify(names));
  check("and what you discarded is invisible", !names.includes("Discarded topic"));

  const pick = wl.suggestions().find((s) => s.name === "US Politics");
  check("counted in sources", pick?.sources === 4, String(pick?.sources));
  check("and outlets", pick?.outlets === 4, String(pick?.outlets));
}

section("Promotion, and declining it");
{
  const added = wl.autoWatch();
  check("the pass adds topics", added.some((a) => a.name === "US Politics"));
  const row = wl.listWatchlist().find((w) => w.label === "US Politics");
  check("as topics, not entities", row?.kind === "topic", row?.kind);
  check("marked as the app's doing", row?.source === "auto", row?.source);
  check("running again adds nothing new", wl.autoWatch().length === 0);

  wl.unwatch(row.id);
  check("removing it takes it off", !wl.listWatchlist().some((w) => w.label === "US Politics"));
  check("and it is never suggested again", !wl.suggestions().some((s) => s.name === "US Politics"));
  wl.watch({ tagId: politics });
  check("choosing it by hand overrides the refusal", wl.listWatchlist().some((w) => w.label === "US Politics"));
}

section("The brief says each thing once");
{
  // Star an entity too: it must not produce a section of its own any more.
  wl.watch({ entityId: trump });
  const from = new Date(Date.now() - 24 * 3600_000);
  const to = new Date(Date.now() + 60_000);
  const m = brief.gather(from, to);

  const headings = m.watched.map((w) => w.label);
  check("topics are the headings", headings.includes("US Politics"), JSON.stringify(headings));
  check("a watched entity gets no section of its own", !headings.includes("Donald Trump"), JSON.stringify(headings));

  const ids = m.watched.flatMap((w) => w.passages.map((p) => p.mention_id));
  check("no passage appears under two headings", ids.length === new Set(ids).size, `${ids.length} vs ${new Set(ids).size}`);
  const otherIds = m.other.map((p) => p.mention_id);
  check(
    "and nothing already used turns up again in everything else",
    !otherIds.some((id) => ids.includes(id))
  );
}

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
