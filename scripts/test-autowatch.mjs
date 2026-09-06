/**
 * The watchlist that learns from what you keep.
 *
 * The properties worth protecting: it counts what you decided to keep and not
 * what merely arrived, a masthead is not a subject, and a suggestion you
 * decline never comes back.
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

/** A kept source from a named outlet, mentioning these entities. */
function source(outlet, triage, entityIds) {
  const sid = Number(
    db().prepare(
      "INSERT INTO sources (title, kind, status, outlet, triage, kept_at) VALUES (?, 'url', 'ready', ?, ?, datetime('now'))"
    ).run(`Piece from ${outlet}`, outlet, triage).lastInsertRowid
  );
  const cid = Number(
    db().prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, 'text', '{}')").run(sid).lastInsertRowid
  );
  for (const eid of entityIds) {
    db().prepare(
      "INSERT INTO mentions (entity_id, source_id, chunk_id, surface, quote, claim) VALUES (?, ?, ?, 's', 'q', 'c')"
    ).run(eid, sid, cid);
  }
  return sid;
}

function entity(name, type = "person") {
  return Number(
    db().prepare("INSERT INTO entities (canonical_name, normalized, type) VALUES (?, ?, ?)").run(name, normalize(name), type).lastInsertRowid
  );
}

const carney = entity("Mark Carney");
const npr = entity("National Public Radio", "org");
const gov = entity("FederalRegister.gov", "work");
const quiet = entity("Someone Minor");

// Five different outlets carry Carney — that is what a subject looks like.
for (const outlet of ["CBC", "Politico", "NPR", "The Hill", "Axios"]) {
  source(outlet, "kept", [carney]);
}
// A masthead looks different: NPR is named five times and only ever in NPR's
// own pieces. So does the site a feed comes from.
for (let i = 0; i < 5; i++) source("NPR", "kept", [npr]);
for (let i = 0; i < 5; i++) source("Federal Register", "kept", [gov]);
source("CBC", "kept", [quiet]);
source("Politico", "kept", [quiet]);
// And a discarded pile that would otherwise dominate.
const discarded = entity("Discarded Subject");
for (const outlet of ["CBC", "Politico", "NPR", "The Hill", "Axios", "BBC News"]) {
  source(outlet, "discarded", [discarded]);
}

section("What earns a place");
{
  const picks = wl.suggestions();
  const names = picks.map((p) => p.name);
  check("a subject several outlets cover is suggested", names.includes("Mark Carney"), JSON.stringify(names));
  check("an outlet naming itself is not", !names.includes("National Public Radio"), JSON.stringify(names));
  check("nor is a website the sources came from", !names.includes("FederalRegister.gov"));
  check("nor is something that barely appeared", !names.includes("Someone Minor"));
  check(
    "and what you discarded is invisible, however often it appeared",
    !names.includes("Discarded Subject"),
    JSON.stringify(names)
  );
  const carneyPick = picks.find((p) => p.name === "Mark Carney");
  check("the count is of sources, not mentions", carneyPick?.sources === 5, String(carneyPick?.sources));
  check("and it says how many outlets", carneyPick?.outlets === 5, String(carneyPick?.outlets));
}

section("Promotion, and declining it");
{
  const added = wl.autoWatch();
  check("the pass adds what it found", added.some((a) => a.name === "Mark Carney"));
  const row = wl.listWatchlist().find((w) => w.label === "Mark Carney");
  check("the row says the app put it there", row?.source === "auto", row?.source);
  check("with a note saying why", /5 of the sources you kept/.test(row?.note ?? ""), row?.note ?? "");

  check("running again adds nothing new", wl.autoWatch().length === 0);

  wl.unwatch(row.id);
  check("removing it takes it off the list", !wl.listWatchlist().some((w) => w.label === "Mark Carney"));
  check("and it is not suggested again", !wl.suggestions().some((s) => s.name === "Mark Carney"));
  check("nor added again", wl.autoWatch().length === 0);

  // A star overrides the refusal.
  wl.watch({ entityId: carney });
  const starred = wl.listWatchlist().find((w) => w.label === "Mark Carney");
  check("starring it by hand puts it back", Boolean(starred), JSON.stringify(wl.listWatchlist().map((w) => w.label)));
  check("as yours, not the app's", starred?.source === "user", starred?.source);
  wl.unwatch(starred.id);
  check(
    "and removing your own star is not recorded as a refusal",
    wl.suggestions().some((s) => s.name === "Mark Carney")
  );
}

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
