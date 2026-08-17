/**
 * The repairs an audit of the library asked for.
 *
 * Every check here stands for something that was measured going wrong across 30
 * entities and 478 passages, not for something that might. The numbers in the
 * comments are from that audit.
 *
 *   node scripts/test-fidelity.mjs
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

const { dedupeByQuote, isFromContext, FROM_CONTEXT_CONFIDENCE } = await import("../lib/types.ts");
const { stripDateSuffix, bestName } = await import("../lib/canonical.ts");

/* ------------------------------------------------- the false "weak" warning */

section("Telling evidence recovered from context apart from evidence merely swept up");
{
  // Extraction writes 0.6 when it took the name from the surrounding text. The
  // name-matching sweep writes 0.8 for evidence it found *by* the name, which is
  // therefore certainly named. Testing `confidence < 1` conflated them and told
  // the writer "this passage does not name the subject" about 351 passages that
  // named it, against the 1 that did not.
  check("a name taken from the surroundings is flagged", isFromContext(0.6));
  check("and anything below that too", isFromContext(0.5));
  check(
    "a passage the sweep found by name is NOT flagged",
    !isFromContext(0.8),
    "it contains the name by construction — the warning was backwards"
  );
  check("nor is ordinary evidence", !isFromContext(1));
  check("the threshold is the value extraction actually writes", FROM_CONTEXT_CONFIDENCE === 0.6);
}

/* --------------------------------------------------------- duplicate quotes */

section("One passage cited once, however many times it was recorded");
{
  const row = (id, quote, claim = null, context = null) => ({ id, quote, claim, context });

  const tripled = [
    row(1, "Al Saud did not consider running a deficit to build an irresponsible decision."),
    row(2, "Al Saud did not consider running a deficit to build an irresponsible decision."),
    row(3, "Al Saud did not consider running a deficit to build an irresponsible decision."),
  ];
  check("three records of one sentence become one", dedupeByQuote(tripled).length === 1);

  check(
    "whitespace and case do not make a passage new",
    dedupeByQuote([row(1, "The  King   returned."), row(2, "the king returned.")]).length === 1
  );

  const mixed = [
    row(1, "Childs arrived at a critical juncture."),
    row(2, "Childs arrived at a critical juncture.", "Childs arrived at a critical moment", "1946"),
    row(3, "A different sentence entirely, about somebody else."),
  ];
  const kept = dedupeByQuote(mixed);
  check("distinct passages are all kept", kept.length === 2);
  check(
    "and the copy carrying the annotations wins",
    kept.find((r) => r.quote.startsWith("Childs")).id === 2,
    "the writer needs the claim and the context, not the lowest id"
  );

  check(
    "the order the writer sees is stable",
    dedupeByQuote([row(9, "b"), row(2, "a"), row(5, "c")]).map((r) => r.id).join() === "2,5,9"
  );
  check("nothing in, nothing out", dedupeByQuote([]).length === 0);
}

/* ------------------------------------------------------- dates in headings */

section("A heading identifies the thing; it does not date it");
{
  // The library recorded, from its own sources, that both of these end dates are
  // disputed — while announcing one of them in the title.
  check(
    "an en-dashed range comes off",
    stripDateSuffix("Second Intifada (2000–2008)") === "Second Intifada"
  );
  check("a two-digit end too", stripDateSuffix("First Intifada (1987–93)") === "First Intifada");
  check("a hyphen reads the same as a dash", stripDateSuffix("Suez Crisis (1956-57)") === "Suez Crisis");
  check("a single year comes off", stripDateSuffix("Nakba (1948)") === "Nakba");
  check("as does an approximate one", stripDateSuffix("Foundation (c. 1744)") === "Foundation");
  check("and an open range", stripDateSuffix("Occupation (1967–present)") === "Occupation");

  check(
    "a parenthetical that is not a date is left alone",
    stripDateSuffix("Aramco (Arabian American Oil Company)") ===
      "Aramco (Arabian American Oil Company)"
  );
  check(
    "a name that is only a year survives",
    stripDateSuffix("1948") === "1948",
    "stripping it would leave nothing to call the entity"
  );
  check("an ordinary name is untouched", stripDateSuffix("Abdullah Sulaiman") === "Abdullah Sulaiman");

  check(
    "and the naming pass applies it",
    bestName("Second Intifada (2000–2008)", [], "event") === "Second Intifada"
  );
  check(
    "while still leaving settled names alone",
    bestName("Saudi Aramco", ["Aramco"], "org") === null,
    "a null means no write, so names do not churn"
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
