/**
 * The three defects the 20 September 2026 audit found in the running app.
 *
 * Q-1  A task set aside because every model was busy was charged an attempt
 *      for the wait, and classify() reads attempts as the retry budget — so
 *      entry tasks arrived at their first real error with the budget spent.
 *      Measured that morning: 1,923 entry tasks since 14 September claimed an
 *      average of 30 times each, to a maximum of 97, all with retries = 0.
 *
 * Q-2  A model that escapes its newlines twice put a literal backslash-n into
 *      23 entry bodies, 3 of the 10 briefs and 20 changelogs. The John Kennedy
 *      entry printed its section heading twice and ran the rest together.
 *
 * Q-3  fixedSections split a changelog on a real newline only, so a
 *      double-escaped one became "line one" and was cut mid-word: "…as i".
 *
 * Runs against a scratch database. No API key needed.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-escapes.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__escapes__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
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

// ---------------------------------------------------------------------------
section("Q-2: a newline escaped twice is still a newline");
// ---------------------------------------------------------------------------
const { unescapeText, unescapeModelJson } = await import("../lib/ai/escapes.ts");

check("a literal backslash-n becomes a line break", unescapeText("one\\ntwo") === "one\ntwo");
check("a real line break is left alone", unescapeText("one\ntwo") === "one\ntwo");
check(
  "a body that is half one and half the other comes out whole",
  unescapeText("## Heading\n\nReal.\\n\\n## Heading\\n\\nEscaped.") ===
    "## Heading\n\nReal.\n\n## Heading\n\nEscaped."
);
check("a carriage return pair collapses to one break", unescapeText("a\\r\\nb") === "a\nb");
check("a literal tab is restored", unescapeText("a\\tb") === "a\tb");
check("text with neither is untouched", unescapeText("nothing to do here") === "nothing to do here");
check(
  "a fenced code block is left exactly as written",
  unescapeText("```js\nconst re = /\\n/;\n```") === "```js\nconst re = /\\n/;\n```"
);

check(
  "every string in a parsed response is repaired, however deep",
  JSON.stringify(
    unescapeModelJson({ plan: { title: "A\\nB" }, body: ["x\\ny", { note: "p\\nq" }] })
  ) === JSON.stringify({ plan: { title: "A\nB" }, body: ["x\ny", { note: "p\nq" }] })
);
check("keys are not rewritten", Object.keys(unescapeModelJson({ "a\\nb": 1 }))[0] === "a\\nb");
check(
  "numbers, booleans and nulls survive",
  JSON.stringify(unescapeModelJson({ n: 3, t: true, z: null })) === JSON.stringify({ n: 3, t: true, z: null })
);
check("an empty object is still an object", JSON.stringify(unescapeModelJson({})) === "{}");

// The citation grammar must come through untouched: markers are what the
// whole pedia hangs on, and this rule now runs over every one of them.
check(
  "citation markers pass through unharmed",
  unescapeText("Gaza [[m:50617]] and [[m:50618]].") === "Gaza [[m:50617]] and [[m:50618]]."
);

// ---------------------------------------------------------------------------
section("Q-3: a trimmed changelog reads as trimmed");
// ---------------------------------------------------------------------------
const { fixedSections } = await import("../lib/pipeline/brief.ts");

const escaped = fixedSections({
  stories: [],
  problems: [],
  revised: [{ entity: "Lebanon", changelog: "- Corrected the bomb description.\\n- Removed the 1982 invasion." }],
});
check(
  "a double-escaped changelog still yields only its first line",
  escaped.includes("- Lebanon: Corrected the bomb description.") &&
    !escaped.includes("1982"),
  escaped
);
check("and no literal backslash-n reaches the brief", !escaped.includes("\\n"), escaped);

const real = fixedSections({
  stories: [],
  problems: [],
  revised: [{ entity: "Syria", changelog: "* Added the arms-sale hold.\n* Second line." }],
});
check("a real newline behaves as it always did", real.includes("- Syria: Added the arms-sale hold.") && !real.includes("Second line"));

// Distinct words, so a cut through the middle of one would be visible.
const words = Array.from({ length: 90 }, (_, i) => `alpha${i}`);
const long = fixedSections({
  stories: [],
  problems: [],
  revised: [{ entity: "Gaza Strip", changelog: "- " + words.join(" ") }],
});
check("an over-long line is cut", long.length < 300);
check("the cut is marked with an ellipsis", long.includes("…"), long.slice(-60));
const lastWord = long.replace(/…\s*$/, "").split(" ").pop();
check("and lands on a whole word, not half of one", words.includes(lastWord), lastWord);

const short = fixedSections({
  stories: [],
  problems: [],
  revised: [{ entity: "Apple", changelog: "- Fixed the mapping date." }],
});
check("a line inside the limit gets no ellipsis", !short.includes("…"), short);

// ---------------------------------------------------------------------------
section("Q-1: waiting for a free model is not an attempt");
// ---------------------------------------------------------------------------
const { classify, ProvidersBusyError } = await import("../lib/ai/errors.ts");

check("a busy ring asks to retry", classify(new ProvidersBusyError("all busy"), 3).kind === "retry");
check(
  "and says the wait is free",
  classify(new ProvidersBusyError("all busy"), 3).free === true
);
check(
  "a busy ring never fails the task, however long the outage",
  classify(new ProvidersBusyError("all busy"), 97).kind === "retry"
);

const rateLimited = new Error(
  `429 ${JSON.stringify({
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }],
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "41s" },
      ],
    },
  })}`
);
check("a rate limit is a free wait too", classify(rateLimited, 4).free === true);

// A genuine failure of this task still costs it, or nothing would ever settle.
const network = new Error("fetch failed");
check("a network blip is charged", classify(network, 1).free !== true);
check("and still fails on the fifth try", classify(network, 5).kind === "fail");
check("an unrecognised error still fails on the third", classify(new Error("what?"), 2).kind === "fail");

// ---------------------------------------------------------------------------
section("Q-1: the refund gives the attempt back");
// ---------------------------------------------------------------------------
const { createRun, enqueue, claimNext, refundAttempt } = await import("../lib/queue.ts");
const { db } = await import("../lib/db/index.ts");

const runId = createRun({ kind: "entry", label: "attempt accounting" });
enqueue(runId, [{ kind: "entry", payload: { entityId: 1 } }]);

const attemptsOf = (id) => db().prepare("SELECT attempts FROM tasks WHERE id=?").get(id).attempts;

const task = claimNext();
check("claiming a task counts an attempt", attemptsOf(task.id) === 1);
refundAttempt(task.id);
check("refunding gives it back", attemptsOf(task.id) === 0);

// Ten waits in a row must leave the budget where it started — this is the
// case that was failing: 97 claims, none of them a try.
for (let i = 0; i < 10; i++) {
  db().prepare("UPDATE tasks SET state='pending', not_before=NULL WHERE id=?").run(task.id);
  claimNext();
  refundAttempt(task.id);
}
check("ten waits in a row spend nothing", attemptsOf(task.id) === 0);
check(
  "so the task still has its whole budget for a real error",
  classify(network, attemptsOf(task.id)).kind === "retry"
);

refundAttempt(task.id);
check("a refund never goes below zero", attemptsOf(task.id) === 0);

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
