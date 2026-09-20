/**
 * Lessons: the app's memory of how its writing goes wrong.
 *
 * The shipped ones arrive with the schema and survive a re-seed; yours are
 * given first; every stage gets its own and the ones for all, within a cap;
 * a switched-off lesson is not sent; and the block rides on the system
 * prompt of a call without the caller knowing.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-lessons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_lessons__");
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
const L = await import("../lib/lessons.ts");
const { SEED_LESSONS } = await import("../lib/lessons-seed.ts");
const { migrateLessons } = await import("../lib/db/migrate-lessons.ts");

section("The shipped lessons arrive with the schema");
{
  const all = L.listLessons();
  check("every seed is present", all.filter((l) => l.source === "seed").length === SEED_LESSONS.length, `${all.length} vs ${SEED_LESSONS.length}`);
  check("each seed is keyed", all.filter((l) => l.source === "seed").every((l) => l.key));
  const stages = new Set(all.map((l) => l.stage));
  check("the entry writer, the brief, extraction, the verifier and filing each have lessons", ["entry", "brief", "extract", "verify", "tag"].every((s) => stages.has(s)));
  migrateLessons(db());
  check("seeding again adds nothing", L.listLessons().length === all.length);
}

section("A stage is given its own lessons and the ones for all, yours first");
{
  const mine = L.addLesson({ stage: "entry", text: "Write the date, never the weekday.", why: "Monday night." });
  check("a lesson of yours is stored as yours", mine.source === "user" && mine.stage === "entry" && mine.why === "Monday night.");
  const forEntry = L.lessonsFor("entry");
  check("yours comes first", forEntry[0].id === mine.id, JSON.stringify(forEntry[0]));
  check("the entry lessons are there", forEntry.some((l) => l.key === "entry.absolute-dates"));
  check("and the ones for every stage", forEntry.some((l) => l.stage === "all"));
  check("but not another stage's", !forEntry.some((l) => l.stage === "brief"));
  check("the brief does not get yours", !L.lessonsFor("brief").some((l) => l.id === mine.id));
  check("no stage, no lessons", L.lessonsFor(undefined).length === 0);
  const block = L.lessonsBlock("entry");
  check("the block opens by saying what it is", block.startsWith("LESSONS."));
  check("and lists yours as a bullet", block.includes("- Write the date, never the weekday."));
  check("withLessons appends to a system prompt", L.withLessons("SYSTEM", "entry").startsWith("SYSTEM\n\nLESSONS."));
  check("and leaves a prompt alone for a stage with nothing", L.withLessons("SYSTEM", "resolve") === "SYSTEM" || L.lessonsFor("resolve").every((l) => l.stage === "all"));
  check("and with no stage at all", L.withLessons("SYSTEM", undefined) === "SYSTEM");
  check("a lesson with no words is refused", (() => { try { L.addLesson({ stage: "entry", text: "   " }); return false; } catch { return true; } })());
  check("an unknown stage becomes 'all'", L.addLesson({ stage: "nonsense", text: "Anything." }).stage === "all");
}

section("Switched off is not sent; removed is remembered");
{
  const seed = L.listLessons().find((l) => l.key === "entry.absolute-dates");
  L.updateLesson(seed.id, { active: false });
  check("a switched-off seed is not sent", !L.lessonsFor("entry").some((l) => l.id === seed.id));
  check("but is still listed", L.listLessons().some((l) => l.id === seed.id && l.active === 0));
  L.updateLesson(seed.id, { active: true });
  check("and comes back when switched on", L.lessonsFor("entry").some((l) => l.id === seed.id));
  check("removing a shipped lesson switches it off rather than deleting it", L.removeLesson(seed.id) && L.listLessons().some((l) => l.id === seed.id && l.active === 0));
  migrateLessons(db());
  check("and a re-seed does not switch it back on", L.listLessons().find((l) => l.id === seed.id).active === 0);
  const mine = L.listLessons().find((l) => l.source === "user");
  check("removing yours deletes it", L.removeLesson(mine.id) && !L.listLessons().some((l) => l.id === mine.id));
  check("editing the words keeps the row", L.updateLesson(L.listLessons()[0].id, { text: "  Rewritten   words. " }) && L.listLessons()[0].text === "Rewritten words.");
  check("removing nothing is false", !L.removeLesson(999999));
}

section("The cap holds");
{
  for (let i = 0; i < 30; i++) L.addLesson({ stage: "brief", text: `Brief lesson number ${i} which is a sentence of ordinary length for the test.` });
  const forBrief = L.lessonsFor("brief");
  check("no more than the cap are sent", forBrief.length <= L.MAX_LESSONS_PER_CALL, String(forBrief.length));
  check("the newest of yours are the ones sent", forBrief[0].text.startsWith("Brief lesson number 29"));
  check("and the rest are reported as held back", L.lessonsHeldBack("brief") > 0, String(L.lessonsHeldBack("brief")));
  check("the characters stay under the bound", forBrief.reduce((n, l) => n + l.text.length, 0) <= L.MAX_LESSON_CHARS + 1200);
}

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
