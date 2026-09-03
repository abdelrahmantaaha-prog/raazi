/**
 * The entry writer's guarantees after the 2026-09-03 audit.
 *
 * Every check here stands for something measured going wrong in the live
 * library: 106 entries with citations in a grammar nothing could read, the
 * same 22 entries rewritten on every idle sweep, "U.S." split into a sentence
 * of its own and flagged as unsupported.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-entry.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_entry__");
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

const { normaliseMarkers, citedIds, stripMarkers } = await import("../lib/markers.ts");
const { splitSentences, paragraphSentences } = await import("../lib/sentences.ts");

/* ------------------------------------------------------------ markers */

section("One citation grammar, whatever the model wrote");
{
  check(
    "comma-joined ids inside one bracket pair are split apart",
    normaliseMarkers("Born in 1901 [[m:42993], [m:39206]].") === "Born in 1901 [[m:42993]] [[m:39206]]."
  );
  check(
    "ids joined with 'm:' repeated",
    normaliseMarkers("x [[m:1, m:2, m:3]]") === "x [[m:1]] [[m:2]] [[m:3]]"
  );
  check("semicolons too", normaliseMarkers("x [[m:1; m:2]]") === "x [[m:1]] [[m:2]]");
  check("a single-bracket marker", normaliseMarkers("x [m:12].") === "x [[m:12]].");
  check("whitespace inside", normaliseMarkers("x [[ m:12 ]]") === "x [[m:12]]");
  check("butted markers get a space", normaliseMarkers("x [[m:1]][[m:2]]") === "x [[m:1]] [[m:2]]");
  check(
    "well-formed text is untouched",
    normaliseMarkers("He left [[m:5]] [[m:6]]. Then [[m:7]].") === "He left [[m:5]] [[m:6]]. Then [[m:7]]."
  );
  check(
    "ordinary brackets in prose are left alone",
    normaliseMarkers("the [sic] committee [1948] met") === "the [sic] committee [1948] met"
  );
  check(
    "citedIds reads the repaired form",
    [...citedIds("a [[m:3], [m:9]] b [m:4]")].join() === "3,9,4"
  );
  check("stripMarkers removes them cleanly", stripMarkers("He left [[m:5]] [[m:6]].") === "He left.");
}

/* ---------------------------------------------------------- sentences */

section("Splitting sentences without falling for abbreviations");
{
  const s = splitSentences(
    "U.S. officials said the tariff would hold [[m:12]]. Mr. Carney disagreed on Tuesday [[m:13]]. The vote is on Jan. 9 [[m:14]]."
  );
  check("three sentences, not six", s.length === 3, JSON.stringify(s));
  check("'U.S.' stays with its sentence", s[0].startsWith("U.S. officials"));
  check("'Mr.' does not split", s[1].startsWith("Mr. Carney"));
  check("'Jan.' does not split", s[2].endsWith("[[m:14]]."));

  check(
    "an initial does not split",
    splitSentences("George W. Bush spoke [[m:1]]. He left [[m:2]].").length === 2
  );
  check(
    "a decimal does not split",
    splitSentences("Growth was 3.5 percent [[m:1]]. It fell [[m:2]].").length === 2
  );
  check(
    "a lowercase continuation is not a boundary",
    splitSentences("He met Dr. al-Faisal there [[m:1]].").length === 1
  );
  check(
    "Arabic terminator splits",
    splitSentences("قال الوزير ذلك [[m:1]]؟ ثم غادر [[m:2]].").length === 2
  );
  check(
    "a quote closing after the stop stays attached",
    splitSentences('He said "no." Then he left [[m:3]].')[0] === 'He said "no."'
  );

  const paras = paragraphSentences("## Heading\n\nFirst one here [[m:1]]. Second [[m:2]].\n\n- Item one is long enough [[m:3]].\n- Item two [[m:4]].");
  check("headings are dropped, paragraphs numbered", paras.length === 4 && paras[0].paragraph === 0 && paras[2].paragraph === 1, JSON.stringify(paras));
}

/* ---------------------------------------------------------- repairBody */

section("A dead marker takes its sentence with it, a framing sentence survives");
{
  const { repairBody } = await import("../lib/pipeline/entry.ts");
  const valid = new Set([1, 2, 3]);

  const r = repairBody(
    "Barger's rise was rapid. He joined in 1937 [[m:1]]. He became CEO [[m:99]]. He retired in 1969 [[m:2]] [[m:3]].",
    valid
  );
  check(
    "the sentence citing only a nonexistent passage is removed",
    !r.body.includes("became CEO"),
    r.body
  );
  check("one sentence counted as dropped", r.dropped === 1);
  check("the framing sentence with no marker is kept", r.body.startsWith("Barger's rise was rapid."));
  check("valid sentences are kept in order", r.body.endsWith("He retired in 1969 [[m:2]] [[m:3]]."));

  const r2 = repairBody("He did both [[m:1]] [[m:99]].", valid);
  check("a sentence with one live and one dead marker keeps the live one", r2.body === "He did both [[m:1]]." && r2.dropped === 0, r2.body);

  const r3 = repairBody("Only this [[m:42], [m:1]].", valid);
  check("malformed markers are repaired before validity is judged", r3.body === "Only this [[m:1]]." , r3.body);

  const r4 = repairBody("## Heading [[m:99]]\n\nProse [[m:2]].", valid);
  check("a dead marker in a heading is just removed", r4.body.startsWith("## Heading") && r4.body.includes("Prose [[m:2]]."), r4.body);
}

/* -------------------------------------------------------- staleness */

section("Coverage never queues a rewrite; evidence and requests do");
{
  const { db } = await import("../lib/db/index.ts");
  const { saveConfig } = await import("../lib/config.ts");
  const entries = await import("../lib/entries.ts");
  const chores = await import("../lib/chores.ts");
  saveConfig({ entryThreshold: 3 });

  const sourceId = Number(
    db().prepare("INSERT INTO sources (title, kind, status) VALUES ('S','text','ready')").run().lastInsertRowid
  );
  const chunkId = Number(
    db().prepare("INSERT INTO chunks (source_id, seq, text) VALUES (?, 0, 'text')").run(sourceId).lastInsertRowid
  );
  const make = (name, mentions, state, body, extra = {}) => {
    const id = Number(
      db()
        .prepare("INSERT INTO entities (type, canonical_name, normalized, entry_state) VALUES ('person', ?, ?, ?)")
        .run(name, name.toLowerCase(), state).lastInsertRowid
    );
    const ids = [];
    for (let i = 0; i < mentions; i++) {
      ids.push(
        Number(
          db()
            .prepare("INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote) VALUES (?,?,?,?,?)")
            .run(id, chunkId, sourceId, name, `quote ${name} ${i}`).lastInsertRowid
        )
      );
    }
    if (body !== null) {
      db()
        .prepare(
          "INSERT INTO entries (entity_id, summary, body_md, built_from_hash, flag_rewrites) VALUES (?,?,?,?,?)"
        )
        .run(id, "s", body(ids), "h", extra.flagRewrites ?? 0);
    }
    return { id, ids };
  };

  // Ten quotes, two cited: the old rule called this stale for ever.
  const thin = make("Thin", 10, "fresh", (ids) => `A [[m:${ids[0]}]]. B [[m:${ids[1]}]].`);
  const stale = make("Stale", 10, "stale", (ids) => `A [[m:${ids[0]}]].`);
  const ids = entries.staleEntities().map((e) => e.id);
  check("a fresh entry citing 20% of its evidence is NOT queued", !ids.includes(thin.id));
  check("a stale entry is", ids.includes(stale.id));
  const under = entries.undercovered();
  check("but it is reported as undercovered for you to see", under.some((u) => u.id === thin.id && u.cited === 2 && u.total === 10), JSON.stringify(under));

  saveConfig({ defaultBudget: 1234 });
  const q = entries.queueStaleEntries();
  const run = db().prepare("SELECT budget_cap FROM runs WHERE id=?").get(q.runId);
  check("the idle sweep's run carries the default budget", run.budget_cap === 1234);

  // Flag-driven rewrites stop after two on the same evidence.
  const flagged = make("Flagged", 4, "fresh", (ids) => `A [[m:${ids[0]}]]. B [[m:${ids[1]}]].`, { flagRewrites: 0 });
  const tired = make("Tired", 4, "fresh", (ids) => `A [[m:${ids[0]}]]. B [[m:${ids[1]}]].`, { flagRewrites: 2 });
  const flag = db().prepare("INSERT INTO entry_flags (entity_id, sentence, verdict, note, mention_ids) VALUES (?,?,?,?,?)");
  for (const e of [flagged, tired]) {
    flag.run(e.id, "x", "unsupported", null, "");
    flag.run(e.id, "y", "overstated", null, "");
  }
  const due = chores.flaggedForRewrite().map((f) => f.entityId);
  check("an entry with two flags and no rewrites yet is due", due.includes(flagged.id));
  check("an entry already rewritten twice for its flags is left alone", !due.includes(tired.id));
  check("the morning payload marks the rewrite as flag-driven", (() => {
    const { runId } = chores.queueMorningRun();
    const t = db().prepare("SELECT payload_json FROM tasks WHERE run_id=? AND kind='entry'").all(runId);
    return t.length === 1 && JSON.parse(t[0].payload_json).fromFlags === true;
  })());

  db().close();
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
