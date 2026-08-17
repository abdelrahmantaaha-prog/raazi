/**
 * Entry rendering. Models are inconsistent about blank lines around headings,
 * and occasionally emit a whole entry as one line with markers buried in the
 * prose. The renderer must never show a raw "###", and must never lose a word
 * or split a sentence while tidying one up.
 *
 *   npx tsx scripts/test-render.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

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

const { blocks, normalise } = await import("../app/components/EntryBody.tsx");
const render = (md) => blocks(md);
const kinds = (md) => render(md).map((b) => b.kind).join(",");
const texts = (md) => render(md).map((b) => b.text ?? (b.items ?? []).join(" ")).join(" ");

// ---------------------------------------------------------------------------
section("Well-formed Markdown is left alone");
// ---------------------------------------------------------------------------
const clean = "## Oil policy\n\nFeisal led the teams [[m:12]].";
check("untouched by the repair pass", normalise(clean) === clean, JSON.stringify(normalise(clean)));
check("renders as a heading then a paragraph", kinds(clean) === "h,p", kinds(clean));
check("the heading keeps its level", render(clean)[0].level === 2);

// ---------------------------------------------------------------------------
section("A heading on its own line, but only one newline before it");
// ---------------------------------------------------------------------------
const single = "Intro text [[m:1]].\n## Oil policy\nFeisal led the teams [[m:12]].";
check("still becomes a real heading", kinds(single) === "p,h,p", kinds(single));
check("with the right label", render(single)[1].text === "Oil policy", render(single)[1].text);
check("and its paragraph follows", render(single)[2].text.includes("Feisal led the teams"));

// ---------------------------------------------------------------------------
section("The real defect: markers buried mid-sentence");
// ---------------------------------------------------------------------------
const inline =
  "### Early Life and Character Prince Feisal was the second son of King Abdul Aziz [[m:1]]. " +
  "Throughout his life he prioritized Wahhabi Islam [[m:7]]. " +
  "### Role as Crown Prince King Abdul Aziz envisioned Feisal governing alongside Saud [[m:8]].";

const out = texts(inline);
check("no raw marker reaches the page", !/#{1,6}\s/.test(out), JSON.stringify(out.slice(0, 70)));
check("it breaks into separate paragraphs", render(inline).length > 1, String(render(inline).length));
check(
  "sentences stay whole — nothing is cut mid-clause",
  out.includes("Prince Feisal was the second son of King Abdul Aziz") &&
    out.includes("King Abdul Aziz envisioned Feisal governing alongside Saud")
);
check(
  "not a word is lost",
  inline.replace(/#{1,6} /g, "").split(/\s+/).every((w) => out.includes(w))
);
check("citations survive intact", (out.match(/\[\[m:\d+\]\]/g) ?? []).length === 3);
check(
  "a paragraph-length label is not passed off as a heading",
  !render(inline).some((b) => b.kind === "h" && b.text.length > 90)
);

// ---------------------------------------------------------------------------
section("Things that only look like headings");
// ---------------------------------------------------------------------------
const hash = "The budget was cut by 30# in 1961 [[m:4]].";
check("a stray hash is left alone", normalise(hash) === hash, JSON.stringify(normalise(hash)));
check("and stays one paragraph", kinds(hash) === "p", kinds(hash));

const lists = "## Findings\n\n- First point\n- Second point";
check("lists still parse", kinds(lists) === "h,ul", kinds(lists));
check("with both items", render(lists)[1].items.length === 2);

const quote = "> He wanted the army to be the vanguard.";
check("block quotes still parse", kinds(quote) === "quote", kinds(quote));

// ---------------------------------------------------------------------------
section("Arabic entries");
// ---------------------------------------------------------------------------
const arabic = "## سياسة النفط\n\nقرر جمال عبد الناصر تأميم قناة السويس [[m:9]].";
check("parse the same way", kinds(arabic) === "h,p", kinds(arabic));
check("and keep their text", render(arabic)[1].text.includes("تأميم قناة السويس"));

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
