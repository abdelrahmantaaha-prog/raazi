/**
 * Pictures for entries: name handling and the rules for accepting a match.
 *
 * The acceptance rules are the whole safety story here. A wrong photograph on
 * a research entry is worse than a blank one, and much more convincing than a
 * wrong book cover, so what may be accepted without a human looking is pinned
 * down here rather than left to a comment.
 *
 *   npx tsx scripts/test-portraits.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

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

const { normalize, stripLeadingTitles } = await import("../lib/normalize.ts");
const { bestName } = await import("../lib/canonical.ts");
const { acceptable, searchTerms, commonsThumb } = await import("../lib/portraits.ts");

// ---------------------------------------------------------------------------
section("Titles of more than one word come off");
// ---------------------------------------------------------------------------
// The bug: "minister" was in the word list but sits *second* in "Prime
// Minister Netanyahu", so the rank survived — and Wikidata returns nothing at
// all for the titled form and the right person instantly for the bare one.
check('"Prime Minister Netanyahu" keys as the man', normalize("Prime Minister Netanyahu", "person") === "netanyahu",
  normalize("Prime Minister Netanyahu", "person"));
check('"Deputy Prime Minister Aryeh Deri" too',
  normalize("Deputy Prime Minister Aryeh Deri", "person") === "aryeh deri",
  normalize("Deputy Prime Minister Aryeh Deri", "person"));
check('"Vice President Kamala Harris"',
  normalize("Vice President Kamala Harris", "person") === "kamala harris");
check('"Chief of Staff Gal Hirsch"',
  normalize("Chief of Staff Gal Hirsch", "person") === "gal hirsch");
check('"Attorney General Merrick Garland"',
  normalize("Attorney General Merrick Garland", "person") === "merrick garland");
check('"Crown Prince Mohammed bin Salman"',
  normalize("Crown Prince Mohammed bin Salman", "person") === "mohammed bin salman");
check("Arabic: رئيس الوزراء نتنياهو", normalize("رئيس الوزراء نتنياهو", "person") === "نتنياهو",
  normalize("رئيس الوزراء نتنياهو", "person"));
check("Arabic: ولي العهد محمد بن سلمان",
  normalize("ولي العهد محمد بن سلمان", "person") === "محمد بن سلمان");

section("…without eating names that merely start the same way");
check('"General Motors" keeps both words', normalize("General Motors", "org") === "general motors");
check('"Prime Minister\'s Office" is not a person',
  normalize("Prime Minister's Office", "org") === "prime minister office",
  normalize("Prime Minister's Office", "org"));
check("a longer title wins over the shorter one inside it",
  stripLeadingTitles(["Deputy", "Prime", "Minister", "Aryeh", "Deri"], 1).join(" ") === "Aryeh Deri");
// A title is only a title when a name is left behind it. "Prime Minister" on
// its own is what someone is called in the source, so it stays.
check("stripping never consumes the whole name",
  stripLeadingTitles(["Prime", "Minister"], 1).join(" ") === "Prime Minister",
  stripLeadingTitles(["Prime", "Minister"], 1).join(" "));
// The heading keeps two words, so a rank in front of a lone surname survives
// there even though the match key drops it — "Netanyahu" alone is a worse
// heading than "Prime Minister Netanyahu", and the key is what does the work.
check("a heading keeps a rank rather than fall to a bare surname",
  stripLeadingTitles(["Prime", "Minister", "Netanyahu"], 2).join(" ") === "Prime Minister Netanyahu");
check("while the match key drops it regardless",
  normalize("Prime Minister Netanyahu", "person") === "netanyahu");
check("a heading loses a compound rank when a full name remains",
  bestName("Prime Minister Benjamin Netanyahu", ["Prime Minister Benjamin Netanyahu"], "person") ===
    "Benjamin Netanyahu");

// ---------------------------------------------------------------------------
section("What gets asked of the outside world");
// ---------------------------------------------------------------------------
check("the bare name is tried before the titled one",
  searchTerms("Prime Minister Netanyahu", "person")[0] === "Netanyahu",
  JSON.stringify(searchTerms("Prime Minister Netanyahu", "person")));
check("the titled form is still tried, in case it was the name",
  searchTerms("Prime Minister Netanyahu", "person").includes("Prime Minister Netanyahu"));
check("our own parentheticals are dropped",
  searchTerms("Kohelet Policy Forum (KPF)", "org").includes("Kohelet Policy Forum"),
  JSON.stringify(searchTerms("Kohelet Policy Forum (KPF)", "org")));
check("an organisation's name is not de-ranked",
  searchTerms("General Motors", "org")[0] === "General Motors");
check("Commons filenames are escaped into the URL",
  commonsThumb("Benjamin Netanyahu 2023.jpg").includes("Benjamin%20Netanyahu%202023.jpg"));

// ---------------------------------------------------------------------------
section("Nothing is accepted unattended unless name and kind both agree");
// ---------------------------------------------------------------------------
const person = (over = {}) => ({
  id: "Q43723",
  label: "Benjamin Netanyahu",
  description: "Prime Minister of Israel",
  classes: ["Q5"],
  file: "Netanyahu.jpg",
  typeMatches: true,
  thumb: "…",
  ...over,
});

check("an exact name and the right kind is accepted",
  acceptable(person(), "Benjamin Netanyahu", "person"));
check("a record with no picture is not",
  !acceptable(person({ file: null }), "Benjamin Netanyahu", "person"));
check("the wrong kind of thing is not, however well the name matches",
  !acceptable(person({ typeMatches: false, classes: ["Q11424"] }), "Benjamin Netanyahu", "person"),
  "a film about someone is not a picture of them");
check("a surname resolving to the full name is accepted",
  acceptable(person(), "Netanyahu", "person"));
check("a title in our name does not block the match",
  acceptable(person(), "Prime Minister Netanyahu", "person"));
check("an alias can carry the match",
  acceptable(person(), "Bibi", "person", ["Benjamin Netanyahu"]));
check("a fuller label than our name is accepted",
  acceptable(person({ label: "Mohammed bin Salman Al Saud" }), "Mohammed bin Salman", "person"));
check("a different person of the same surname is refused",
  !acceptable(person({ label: "Netanyahu" }), "Benjamin Netanyahu", "person"),
  "a one-word label answering a full name is the ambiguous direction");
check("an unrelated name is refused",
  !acceptable(person({ label: "Yitzhak Rabin" }), "Benjamin Netanyahu", "person"));
check("diacritics do not defeat a match",
  acceptable(person({ label: "Gamal Abdel Nasser" }), "Gamál Abdel Násser", "person"));
check("a concept has no class list, so it is never accepted unattended",
  !acceptable({ ...person(), typeMatches: false }, "Zionism", "concept"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
