/**
 * Literature review & news: the guards between Claude's answer and the window.
 *
 * The properties: a result Claude named but no search, tool or fetch returned
 * is dropped, however plausible; the review's citations follow the results
 * that survive, and a citation of a dropped one disappears rather than
 * pointing at the wrong paper; reviews are kept per text and per passage;
 * and nothing reaches the model without Claude being set up.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-litreview.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_litreview__");
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

const { db } = await import("../lib/db/index.ts");
const L = await import("../lib/litreview.ts");
const P = await import("../lib/pipeline/litreview.ts");

section("Only what was really opened is kept");
{
  const seen = ["https://journal.example.org/paper-1", "https://news.example.com/story?id=2", "https://think.example.org/report.pdf"];
  const answer = [
    { kind: "paper", title: "Paper one", url: "https://journal.example.org/paper-1", finding: "f", why: "w" },
    { kind: "paper", title: "Remembered paper", url: "https://doi.example.org/10.1/never-opened", finding: "f", why: "w" },
    { kind: "news", title: "Story two", url: "https://news.example.com/story?id=2", finding: "f", why: "w", date: "2026-10-10" },
    { kind: "report", title: "Same paper again", url: "https://journal.example.org/paper-1", finding: "f", why: "w" },
    { kind: "podcast", title: "Report", url: "https://think.example.org/report.pdf", finding: "f", why: "w" },
    { kind: "paper", title: "", url: "https://journal.example.org/paper-1", finding: "f", why: "w" },
  ];
  const r = P.keepReadResults(answer, seen);
  check("a result no search returned is dropped and counted", r.dropped >= 1 && !r.results.some((x) => x.title === "Remembered paper"), JSON.stringify(r));
  check("the same address twice is kept once", r.results.filter((x) => x.url.includes("paper-1")).length === 1);
  check("an unknown kind becomes analysis", r.results.find((x) => x.title === "Report")?.kind === "analysis");
  check("the original numbers of what was kept are remembered", JSON.stringify(r.kept) === "[1,3,5]", JSON.stringify(r.kept));
  const many = Array.from({ length: 30 }, (_, i) => ({ kind: i % 2 ? "news" : "paper", title: `t${i}`, url: `https://x.example/${i}`, finding: "", why: "" }));
  const capped = P.keepReadResults(many, many.map((m) => m.url));
  check("at most ten research and eight news", capped.results.filter((x) => x.kind === "paper").length === 10 && capped.results.filter((x) => x.kind === "news").length === 8);
}

section("Citations follow the results that survived");
{
  check("numbers move up past a dropped result", L.renumberCitations("A [1]. B [3]. C [5].", [1, 3, 5]) === "A [1]. B [2]. C [3].");
  check("a citation of a dropped result disappears", L.renumberCitations("Known [2]. Also [1].", [1, 3]) === "Known. Also [1].", L.renumberCitations("Known [2]. Also [1].", [1, 3]));
  check("lists and ranges are mapped and cleaned", L.renumberCitations("See [1, 2, 4] and [3–5].", [1, 4, 5]) === "See [1, 2] and [2, 3].", L.renumberCitations("See [1, 2, 4] and [3–5].", [1, 4, 5]));
  check("Arabic prose keeps its words", L.renumberCitations("تشير الدراسات [2].", [2]) === "تشير الدراسات [1].");
}

section("Reviews are kept per text and per passage");
{
  const src = Number(db().prepare("INSERT INTO sources (title, kind, status) VALUES ('A source', 'text', 'chunked')").run().lastInsertRowid);
  const whole = L.createReview({ target: "source", targetId: src, focus: null, context: null, title: "A source" });
  const passage = L.createReview({ target: "source", targetId: src, focus: "a passage", context: "the paragraph", title: "A source" });
  check("a review with no run is not shown as searching", L.getReview(whole).state === "failed");
  L.saveReport(whole, { overview: "x [1]", results: [{ kind: "paper", title: "P", url: "https://p.example", finding: "f", why: "w" }], dropped: 0, searchedAt: new Date().toISOString() });
  check("a saved report is done", L.getReview(whole).state === "done" && L.getReview(whole).report.results.length === 1);
  check("the whole text's reviews leave out the passage's", L.reviewsFor("source", src, null).map((r) => r.id).join() === String(whole));
  check("a passage's reviews are only its own", L.reviewsFor("source", src, "a passage").map((r) => r.id).join() === String(passage));
  check("without a focus, every review of the text, newest first", L.reviewsFor("source", src).map((r) => r.id).join() === `${passage},${whole}`);
  const marked = L.markAdded(whole, 0, src);
  check("adding a result to the library is remembered on it", marked.report.results[0].sourceId === src);
  check("the task's input carries the passage and its paragraph", L.reviewInput(passage).focus === "a passage" && L.reviewInput(passage).context === "the paragraph");
}

section("Without Claude, nothing is asked");
{
  const { POST } = await import("../app/api/litreview/route.ts");
  const src = db().prepare("SELECT id FROM sources LIMIT 1").get().id;
  const res = await POST(new Request("http://x/api/litreview", { method: "POST", body: JSON.stringify({ action: "start", target: "source", id: src }) }));
  const body = await res.json();
  check("a start without Claude set up is refused, and says why", res.status === 400 && /Claude/.test(body.error ?? ""), JSON.stringify(body));
  check("and no task was queued", db().prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind='litreview'").get().n === 0);
}

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
