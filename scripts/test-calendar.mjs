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
  check("spring of 2027 → the season, filed with the months", b("in the spring of 2027")?.key === "2027-05" && b("in the spring of 2027")?.label === "Sometime in spring 2027", JSON.stringify(b("in the spring of 2027")));
  check("winter of 2027 → year, since it straddles two", b("in the winter of 2027")?.key === "2027");
  check("a bare year → year", b("the 2003 invasion")?.key === "2003");
  check("the 1990s → decade", b("in the 1990s")?.label === "Sometime in the 1990s");
}

section("A day named without a year is this year's only if it is still to come");
// The Oct. 7 case, from the live library: the extractor rightly left the year
// unknown, and the calendar then stamped the publication year on it — filing
// the attack five weeks ahead. What tells "the Oct. 7 attack" from "the vote
// on Oct. 19" is the summary's tense.
{
  const b = (text, summary, iso = null) =>
    cal.bucketFor({ date_iso: iso, precision: iso ? "day" : "unknown", date_text: text, summary }, PUB);
  const attack = "Hamas launched an attack resulting in 1,200 Israelis killed and hundreds taken hostage.";
  check("a past event on a day after publication is an anniversary", b("Oct. 7", attack)?.kind === "annual");
  check("keyed by month and day only", b("Oct. 7", attack)?.key === "10-07", b("Oct. 7", attack)?.key);
  check("and labelled as recurring", b("Oct. 7", attack)?.label === "Every 7 October", b("Oct. 7", attack)?.label);
  check("a scheduled thing on a day ahead is this year's", b("Oct. 19", "Alberta is scheduled to hold a referendum")?.key === "2026-10-19");
  check("'prepares to travel on' is future wording", b("September 24", "Xi Jinping prepares to travel to Washington on September 24.")?.key === "2026-09-24");
  check("'is set to' is future wording even with a past-looking verb", b("Nov. 3", "Midterm election day scheduled.")?.key === "2026-11-03");
  check("a past event a few days before publication is this year's", b("Sept. 3", "The strike ended after talks.")?.key === "2026-09-03");
  check("no summary at all keeps the old rule", b("Oct. 20", null)?.key === "2026-10-20");
  check("an explicit year is never second-guessed", b("7 October 2023", attack)?.key === "2023-10-07");
  check("the extractor's own publication-year slip is caught too", b("Oct. 7", attack, "2026-10-07")?.kind === "annual");
  check("but a dated iso with a year in the wording stands", b("7 October 2026", "The attack happened.", "2026-10-07")?.key === "2026-10-07");
  check("'anniversary' wording is annual wherever it falls", b("September 11", "The city marked the anniversary of the attacks.")?.kind === "annual");
  check("'years since' too", b("September 11", "Twenty-five years since the towers fell.")?.key === "09-11");
  check("an ISO recurring form is understood", b("Oct. 7", attack, "--10-07")?.key === "10-07");
  check("readsAsPast: launched/killed", cal.readsAsPast(attack));
  check("readsAsPast: not when scheduled", !cal.readsAsPast("The House is scheduled to reconvene."));
  check("readsAsPast: empty is not past", !cal.readsAsPast(""));
  const now = new Date(2026, 8, 12);
  check("an anniversary is never past", cal.tenseOf({ kind: "annual", key: "10-07" }, now) === "upcoming");
  check("it is current on the day", cal.tenseOf({ kind: "annual", key: "09-12" }, now) === "current");
  check("next occurrence rolls into next year once passed", cal.nextOccurrence("01-15", now) === "2027-01-15");
  check("next occurrence this year when ahead", cal.nextOccurrence("10-07", now) === "2026-10-07");
}

section("Relative wording is read from the words, not from the extractor's rounding");
{
  const b = (text, iso, precision = "day", summary = "It happened.") =>
    cal.bucketFor({ date_iso: iso, precision, date_text: text, summary }, PUB);
  check("'last week' with a day iso is still a week", b("last week", "2026-09-02")?.kind === "week" && b("last week", "2026-09-02")?.key === "2026-08-28", JSON.stringify(b("last week", "2026-09-02")));
  check("'as soon as this week' is this week, not a day", b("as soon as this week", "2026-09-09")?.kind === "week");
  check("'just a few days after' with precision unknown is a week around the extractor's day", b("just a few days after", "2026-09-05", "unknown")?.kind === "week" && b("just a few days after", "2026-09-05", "unknown")?.key === "2026-09-04", JSON.stringify(b("just a few days after", "2026-09-05", "unknown")));
  check("'three days later' is a week around the day the extractor reached", b("Three days later", "2026-08-27")?.kind === "week" && b("Three days later", "2026-08-27")?.key === "2026-08-21");
  check("'a day after' too", b("a day after", "2026-09-05")?.kind === "week");
  check("'this past weekend' is the weekend just gone", b("this past weekend", "2026-09-06")?.kind === "week" && b("this past weekend", "2026-09-06")?.key === "2026-09-04", JSON.stringify(b("this past weekend", "2026-09-06")));
  check("'over the weekend' the same", b("over the weekend", "2026-09-06")?.key === "2026-09-04");
  check("'in two weeks' is a week ahead", b("in two weeks", "2026-09")?.kind === "week" && b("in two weeks", "2026-09")?.key === "2026-09-18", JSON.stringify(b("in two weeks", "2026-09")));
  check("'29 years ago' is a year", b("29 years ago", "1997", "decade")?.key === "1997" && b("29 years ago", "1997", "decade")?.kind === "year");
  check("'three days ago' is a day", b("three days ago", "2026-09-06")?.key === "2026-09-06");
  check("'this summer' is over by September", b("this summer", "2026", "year")?.kind === "month" && cal.tenseOf(b("this summer", "2026", "year"), new Date(2026, 8, 11)) === "past", JSON.stringify(b("this summer", "2026", "year")));
  check("and labelled as the season", b("this summer", "2026", "year")?.label === "Sometime in summer 2026");
  check("'last spring' is last year's", b("last spring", null, "unknown")?.key === "2025-05");
  check("a day iso with precision unknown is a week, never a day", b("", "2026-09-05", "unknown")?.kind === "week");
  check("a fixed weekday is that day even at a commemoration", b("Friday", "2026-09-04", "day", "Spoke at a September 11 anniversary ceremony at the Pentagon.")?.kind === "day" && b("Friday", "2026-09-04", "day", "Spoke at a September 11 anniversary ceremony at the Pentagon.")?.key === "2026-09-04");
  check("'this past weekend' at a commemorative ceremony is that weekend, not an anniversary", b("this past weekend", "2026-09-06", "day", "Shook hands at the 9/11 commemorative ceremony.")?.kind === "week");
  check("but a bare month-and-day at an anniversary still recurs", b("September 11", "2026-09-11", "day", "The city marked the anniversary of the attacks.")?.kind === "annual");
  check("a month and a weekday keeps the absolute reading", b("Sunday, Sept. 6", "2026-09-06")?.key === "2026-09-06" && b("Sunday, Sept. 6", "2026-09-06")?.kind === "day", JSON.stringify(b("Sunday, Sept. 6", "2026-09-06")));
  check("a bare month in the publication year is that month", b("in September", null, "unknown")?.key === "2026-09" && b("in September", null, "unknown")?.kind === "month");
  check("'later in September' too", b("later in September", "2026-09", "month")?.key === "2026-09");
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

  ins.run(entityId, "1889", "1889", "year", "The Chinese Exclusion Case was decided.", sourceId);
  check("a date from the deep past is filed", cal.logCalendar(from, to, "2026-09-10") === 1);
  const forBrief = cal.calendarFor("2026-09-10");
  check("the brief's own block lists what it filed", forBrief.length === 4);
  check("but the deep past is not under the brief", !forBrief.some((r) => r.summary.startsWith("The Chinese Exclusion")));
  check("it is still on the whole calendar", cal.listCalendar({ now: new Date(2026, 8, 11) }).sometime.some((g) => g.items.some((r) => r.summary.startsWith("The Chinese Exclusion"))));
  const id = forBrief[0].id;
  check("dismissing hides a line", cal.dismissCalendar(id) && cal.calendarFor("2026-09-10").length === 3);
  check("restoring brings it back", cal.dismissCalendar(id, false) && cal.calendarFor("2026-09-10").length === 4);

  const outside = cal.logCalendar(new Date("2026-01-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"), "x");
  check("a window with no sources files nothing", outside === 0);

  // A line filed under the old rule — the attack as a day five weeks ahead —
  // is moved to its anniversary by the refile, which every filing runs first.
  const attackEvent = Number(
    ins.run(entityId, "Oct. 7", null, "unknown", "Hamas launched an attack that killed 1,200 people.", sourceId).lastInsertRowid
  );
  db()
    .prepare(
      `INSERT INTO calendar (event_id, entity_id, source_id, kind, bucket, label, date_text, summary, logged_from)
       VALUES (?, ?, ?, 'day', '2026-10-07', '7 Oct 2026', 'Oct. 7', 'Hamas launched an attack that killed 1,200 people.', 'old')`
    )
    .run(attackEvent, entityId, sourceId);
  const before = cal.listCalendar({ now: new Date(2026, 8, 11) });
  check("mis-filed, the attack shows as coming up", before.upcoming.some((r) => r.event_id === attackEvent));
  const moved = cal.refileCalendar();
  check("the refile moves it", moved === 1, String(moved));
  const after = cal.listCalendar({ now: new Date(2026, 8, 11) });
  check("it is no longer an upcoming day", !after.upcoming.some((r) => r.event_id === attackEvent));
  const ann = after.annual.find((r) => r.event_id === attackEvent);
  check("it is an anniversary", ann?.kind === "annual" && ann.bucket === "10-07");
  check("and it is not in the sometime groups", !after.sometime.some((g) => g.items.some((r) => r.event_id === attackEvent)));
  check("a second refile moves nothing", cal.refileCalendar() === 0);
  check("filing again still adds nothing and keeps the fix", cal.logCalendar(from, to, "2026-09-10") === 0 && cal.listCalendar().annual.length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
