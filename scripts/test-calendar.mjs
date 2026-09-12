/**
 * The watching calendar.
 *
 * Two properties. Bucketing never claims more precision than the source
 * gave: "last week" against a publication date is a week, not a day, and a
 * bare year is a year. And filing is idempotent: writing the same brief
 * twice does not put the same election on the calendar twice.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-calendar.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_calendar__");
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
const cal = await import("../lib/calendar.ts");

const PUB = "2026-09-09T10:00:00.000Z"; // a Wednesday

section("A fixed date is a day; a vaguer one is only as precise as the source");
{
  const b = (ev) => cal.bucketFor({ date_iso: null, precision: null, date_text: null, ...ev }, PUB);
  check("day precision → day", b({ date_iso: "2026-10-20", precision: "day" })?.key === "2026-10-20");
  check("month precision → month", b({ date_iso: "2026-10", precision: "month" })?.kind === "month");
  check("month label reads as 'Sometime in'", b({ date_iso: "2026-10", precision: "month" })?.label === "Sometime in October 2026");
  check("year precision → year", b({ date_iso: "2027", precision: "year" })?.key === "2027");
  check("day iso with year precision is demoted", b({ date_iso: "2026-03-14", precision: "year" })?.kind === "year");
  check("decade reads as the decade", b({ date_iso: "1950", precision: "decade" })?.label === "Sometime in the 1950s");
  check("nothing at all → null", b({}) === null);
  check("unknown words → null", b({ date_text: "eventually" }) === null);
}

section("Relative wording is read against the publication date");
{
  const b = (text) => cal.bucketFor({ date_iso: null, precision: "unknown", date_text: text }, PUB);
  check("yesterday → the day before", b("yesterday")?.key === "2026-09-08");
  check("tomorrow → the day after", b("tomorrow")?.key === "2026-09-10");
  check("last week → the previous week (Friday-based)", b("last week")?.key === "2026-08-28" && b("last week")?.kind === "week");
  check("next week → the following week", b("next week")?.key === "2026-09-11");
  check("earlier this week → this week", b("earlier this week")?.key === "2026-09-04");
  check("last month → August", b("last month")?.key === "2026-08");
  check("next month → October", b("next month")?.key === "2026-10");
  check("in recent weeks → this month", b("in recent weeks")?.key === "2026-09");
  check("last year → 2025", b("last year")?.key === "2025");
  check("early next year → 2027", b("early next year")?.key === "2027");
  check("later this year → 2026", b("later this year")?.key === "2026");
  check("on Tuesday → most recent Tuesday", b("on Tuesday")?.key === "2026-09-08");
  check("on Wednesday → publication day itself", b("on Wednesday")?.key === "2026-09-09");
  check("next Monday → the Monday after", b("next Monday")?.key === "2026-09-14");
  check("relative words with no publication date → null", cal.bucketFor({ date_iso: null, precision: null, date_text: "last week" }, null) === null);
}

section("Absolute wording needs no anchor");
{
  const b = (text) => cal.bucketFor({ date_iso: null, precision: "unknown", date_text: text }, PUB);
  check("October 2027 → month", b("October 2027")?.key === "2027-10");
  check("Oct. 20 → day in the publication year", b("Oct. 20")?.key === "2026-10-20");
  check("20 October 2027 → day", b("20 October 2027")?.key === "2027-10-20");
  check("spring of 2027 → year", b("in the spring of 2027")?.key === "2027");
  check("a bare year → year", b("the 2003 invasion")?.key === "2003");
  check("the 1990s → decade", b("in the 1990s")?.label === "Sometime in the 1990s");
}

section("Tense is judged as of a day");
{
  const now = new Date(2026, 8, 11); // 11 Sep 2026
  check("yesterday is past", cal.tenseOf({ kind: "day", key: "2026-09-10" }, now) === "past");
  check("today is current", cal.tenseOf({ kind: "day", key: "2026-09-11" }, now) === "current");
  check("next month is upcoming", cal.tenseOf({ kind: "month", key: "2026-10" }, now) === "upcoming");
  check("this month is current", cal.tenseOf({ kind: "month", key: "2026-09" }, now) === "current");
  // Weeks run Friday to Thursday; 11 Sep 2026 is a Friday, so the week of
  // the 4th closed the day before.
  check("the week that ended is past", cal.tenseOf({ kind: "week", key: "2026-09-04" }, now) === "past");
  check("this week is current", cal.tenseOf({ kind: "week", key: "2026-09-11" }, now) === "current");
  check("next week is upcoming", cal.tenseOf({ kind: "week", key: "2026-09-18" }, now) === "upcoming");
  check("next year is upcoming", cal.tenseOf({ kind: "year", key: "2027" }, now) === "upcoming");
}

section("Filing from a window is idempotent and grouped");
{
  const sourceId = Number(
    db()
      .prepare("INSERT INTO sources (title, kind, status, published_at, kept_at, triage) VALUES ('Wire', 'url', 'ready', ?, ?, 'kept')")
      .run(PUB, PUB).lastInsertRowid
  );
  const entityId = Number(
    db().prepare("INSERT INTO entities (type, canonical_name, normalized) VALUES ('event', 'Election', 'election')").run().lastInsertRowid
  );
  const ins = db().prepare(
    "INSERT INTO events (entity_id, date_text, date_iso, precision, summary, source_id) VALUES (?, ?, ?, ?, ?, ?)"
  );
  ins.run(entityId, "October 20", "2026-10-20", "day", "Polling day", sourceId);
  ins.run(entityId, "last week", null, "unknown", "Campaign launched", sourceId);
  ins.run(entityId, "next month", null, "unknown", "Debate expected", sourceId);
  ins.run(entityId, "eventually", null, "unknown", "Results certified", sourceId);
  ins.run(entityId, "yesterday", "2026-09-08", "day", "Candidate withdrew", sourceId);

  const from = new Date("2026-09-08T00:00:00Z");
  const to = new Date("2026-09-10T00:00:00Z");
  const first = cal.logCalendar(from, to, "2026-09-10");
  check("four of five events filed (the undatable one is left out)", first === 4, String(first));
  const again = cal.logCalendar(from, to, "2026-09-10");
  check("filing again adds nothing", again === 0, String(again));

  const sections = cal.listCalendar({ now: new Date(2026, 8, 11) });
  check("polling day is coming up", sections.upcoming.some((r) => r.summary === "Polling day"));
  check("the withdrawal is past", sections.past.some((r) => r.summary === "Candidate withdrew"));
  const sometime = sections.sometime.map((g) => g.label);
  check("'last week' is a week group", sometime.includes("Sometime in the week of 28 Aug 2026"), sometime.join(" / "));
  check("'next month' is a month group", sometime.includes("Sometime in October 2026"), sometime.join(" / "));
  check("future groups come before past ones", sometime[0] === "Sometime in October 2026", sometime.join(" / "));

  const forBrief = cal.calendarFor("2026-09-10");
  check("the brief's own block lists what it filed", forBrief.length === 4);
  const id = forBrief[0].id;
  check("dismissing hides a line", cal.dismissCalendar(id) && cal.calendarFor("2026-09-10").length === 3);
  check("restoring brings it back", cal.dismissCalendar(id, false) && cal.calendarFor("2026-09-10").length === 4);

  const outside = cal.logCalendar(new Date("2026-01-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"), "x");
  check("a window with no sources files nothing", outside === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
