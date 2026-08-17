/**
 * Tags organise without partitioning. The property worth protecting: an entity
 * that turns up in two unrelated topics stays ONE entity with two tags, never
 * two entities.
 *
 *   npx tsx scripts/test-tags.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__tags__");
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
const tags = await import("../lib/tags.ts");
const { listEntities, typeCounts, search } = await import("../lib/queries.ts");

// --- a tiny library spanning two unrelated topics ---------------------------
const mkSource = (title) =>
  Number(
    db().prepare("INSERT INTO sources (title, kind, status) VALUES (?, 'text', 'ready')").run(title)
      .lastInsertRowid
  );
const mkChunk = (sourceId, text) =>
  Number(
    db()
      .prepare("INSERT INTO chunks (source_id, seq, text) VALUES (?, 0, ?)")
      .run(sourceId, text).lastInsertRowid
  );
const mkEntity = (name, type = "person") =>
  Number(
    db()
      .prepare("INSERT INTO entities (type, canonical_name, normalized) VALUES (?, ?, ?)")
      .run(type, name, name.toLowerCase()).lastInsertRowid
  );
const mkMention = (entityId, chunkId, sourceId, quote) =>
  db()
    .prepare(
      "INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote) VALUES (?,?,?,?,?)"
    )
    .run(entityId, chunkId, sourceId, "x", quote);

const egyptSrc = mkSource("A history of Egypt");
const coldWarSrc = mkSource("The Non-Aligned Movement");
const egyptChunk = mkChunk(egyptSrc, "Nasser chaired the Revolutionary Command Council.");
const coldWarChunk = mkChunk(coldWarSrc, "Nasser met Nehru at Bandung in 1955.");

const nasser = mkEntity("Nasser");
const naguib = mkEntity("Naguib");
const nehru = mkEntity("Nehru");

mkMention(nasser, egyptChunk, egyptSrc, "Nasser chaired the Revolutionary Command Council.");
mkMention(nasser, coldWarChunk, coldWarSrc, "Nasser met Nehru at Bandung in 1955.");
mkMention(naguib, egyptChunk, egyptSrc, "Nasser chaired the Revolutionary Command Council.");
mkMention(nehru, coldWarChunk, coldWarSrc, "Nasser met Nehru at Bandung in 1955.");

const egypt = tags.ensureTag("Egypt");
const coldWar = tags.ensureTag("Cold War");
tags.setSourceTags(egyptSrc, [egypt]);
tags.setSourceTags(coldWarSrc, [coldWar]);

// ---------------------------------------------------------------------------
section("One entity, many topics — never split");
// ---------------------------------------------------------------------------
const nasserTags = tags.tagsForEntity(nasser).map((t) => t.name).sort();
check("a person in two topics carries both", nasserTags.join() === "Cold War,Egypt", nasserTags.join());
check(
  "and is still a single entity with all its evidence",
  (db().prepare("SELECT COUNT(*) n FROM mentions WHERE entity_id=?").get(nasser)).n === 2
);
check(
  "an entity in only one topic carries only that one",
  tags.tagsForEntity(naguib).map((t) => t.name).join() === "Egypt"
);

// ---------------------------------------------------------------------------
section("Tags are derived, so re-filing a source re-tags everyone in it");
// ---------------------------------------------------------------------------
tags.setSourceTags(coldWarSrc, [coldWar, egypt]);
check(
  "adding a topic to a source gives it to that source's entities",
  tags.tagsForEntity(nehru).map((t) => t.name).sort().join() === "Cold War,Egypt",
  tags.tagsForEntity(nehru).map((t) => t.name).join()
);
tags.setSourceTags(coldWarSrc, [coldWar]);
check(
  "removing it takes the tag away again — no stale state to rebuild",
  tags.tagsForEntity(nehru).map((t) => t.name).join() === "Cold War"
);

// ---------------------------------------------------------------------------
section("Your overrides win over what was derived");
// ---------------------------------------------------------------------------
tags.setEntityTag(nehru, egypt, true);
check(
  "you can add a topic the sources didn't imply",
  tags.tagsForEntity(nehru).some((t) => t.name === "Egypt" && t.origin === "manual")
);
tags.setEntityTag(nehru, egypt, false);
check("and take it back off", !tags.tagsForEntity(nehru).some((t) => t.name === "Egypt"));

tags.setEntityTag(nasser, egypt, false);
check(
  "hiding a derived topic hides it on that entity",
  !tags.tagsForEntity(nasser).some((t) => t.name === "Egypt"),
  tags.tagsForEntity(nasser).map((t) => t.name).join()
);
check(
  "but leaves it on the source, where it came from",
  tags.tagsForSource(egyptSrc).some((t) => t.name === "Egypt")
);
check(
  "and leaves other entities in that source alone",
  tags.tagsForEntity(naguib).some((t) => t.name === "Egypt")
);
tags.setEntityTag(nasser, egypt, true);
check("unhiding restores it", tags.tagsForEntity(nasser).some((t) => t.name === "Egypt"));

// ---------------------------------------------------------------------------
section("Filtering");
// ---------------------------------------------------------------------------
const inEgypt = listEntities({ tagId: egypt }).map((e) => e.canonical_name).sort();
check("filtering by a topic returns only its entities", inEgypt.join() === "Naguib,Nasser", inEgypt.join());

const inColdWar = listEntities({ tagId: coldWar }).map((e) => e.canonical_name).sort();
check("the other topic returns its own", inColdWar.join() === "Nasser,Nehru", inColdWar.join());

check("unfiltered still returns everything", listEntities().length === 3);
check(
  "type counts respect the filter",
  typeCounts(egypt).person === 2 && typeCounts().person === 3,
  `${JSON.stringify(typeCounts(egypt))} vs ${JSON.stringify(typeCounts())}`
);

const hits = search("Bandung", { tagId: egypt });
check("search scoped to a topic excludes other topics' sources", hits.chunks.length === 0, `${hits.chunks.length} hits`);
check("and finds them when scoped to the right one", search("Bandung", { tagId: coldWar }).chunks.length === 1);

// ---------------------------------------------------------------------------
section("Housekeeping");
// ---------------------------------------------------------------------------
check("tag names are case-insensitive — no accidental twins", tags.ensureTag("egypt") === egypt);

const counts = tags.listTags().find((t) => t.id === egypt);
check("a tag knows how many sources and entities it covers", counts.sources === 1 && counts.entities === 2,
  `${counts.sources} sources / ${counts.entities} entities`);

tags.deleteTag(coldWar);
check("deleting a tag removes only the label", listEntities().length === 3);
check(
  "the entities it covered keep every quote",
  (db().prepare("SELECT COUNT(*) n FROM mentions").get()).n === 4
);

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
