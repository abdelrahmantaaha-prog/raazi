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


// ---------------------------------------------------------------------------
section("Names that begin with an article, and acronyms, still link");
// ---------------------------------------------------------------------------
{
  const { linkEntities } = await import("../lib/entity-links.ts");
  const targets = [
    { id: 1, name: "The White House" },
    { id: 2, name: "The Globe and Mail" },
    { id: 3, name: "CIA" },
    { id: 4, name: "UN" },
    { id: 5, name: "the party" },
    { id: 6, name: "Nasser" },
  ];
  const linked = (text) =>
    linkEntities(text, targets)
      .filter((s) => s.entityId !== undefined)
      .map((s) => s.entityId);

  check("The White House links", linked("He went to The White House.").includes(1));
  check("the White House links case-insensitively", linked("the White House said").includes(1));
  check("The Globe and Mail links", linked("The Globe and Mail reported it").includes(2));
  check("a generic 'the party' does not", !linked("the party met").includes(5));
  check("CIA links", linked("the CIA denied it").includes(3));
  check("CIA does not match inside a word", !linked("especially").includes(3));
  check("UN stays out", !linked("the UN voted").includes(4));
  check("ordinary names still link", linked("Nasser spoke").includes(6));
}

// ---------------------------------------------------------------------------
section("Citation markers are numbered by where they are first cited");
// ---------------------------------------------------------------------------
{
  const { markerHtml, normalizeMarkers } = await import("../lib/cite-markers.ts");
  const refs = [{ id: 10 }, { id: 11 }, { id: 12 }];
  // Cited in the text in the order 12, 10, 11 — not the order they were added.
  const html = "<p>One" + markerHtml(12) + "two" + markerHtml(10) + "three" + markerHtml(11) + "again" + markerHtml(12) + "</p>";
  const out = normalizeMarkers(html, refs);

  check("a marker carries its id", /data-cite="11"/.test(markerHtml(11)));
  check("the first cited is [1], whatever its place in the list", /One<span data-cite="12"[^>]*>\[1\]</.test(out), out);
  check("the next is [2]", /two<span data-cite="10"[^>]*>\[2\]</.test(out), out);
  check("a second citation of a source keeps its number", /again<span data-cite="12"[^>]*>\[1\]</.test(out), out);
  check("the list index is kept for older copies", /data-cite="11" data-note="1"/.test(out), out);
  check("stable when nothing changed", normalizeMarkers(out, refs) === out);

  const dropped = normalizeMarkers(out, [{ id: 11 }, { id: 12 }]);
  check("a missing reference's marker reads [?] and stays", /data-cite="10"[^>]*>\[\?\]</.test(dropped), dropped);
  check("and takes no number from the others", /three<span data-cite="11"[^>]*>\[2\]</.test(dropped), dropped);

  const legacy = '<p>Old<span data-note="1" contenteditable="false">[2]</span> text</p>';
  const upgraded = normalizeMarkers(legacy, refs);
  check("a marker from before ids gets the id at its index", /data-cite="11"/.test(upgraded), upgraded);
  check("a legacy marker past the end is removed", normalizeMarkers(legacy, [{ id: 10 }]) === "<p>Old text</p>");

  const typedInto = '<p>A<span data-cite="10" contenteditable="false">[1] and words</span></p>';
  const rescued = normalizeMarkers(typedInto, refs);
  check("words typed into a marker are put back after it", /\[1\]<\/span> and words<\/p>$/.test(rescued), rescued);
}

// ---------------------------------------------------------------------------
section("Dates are read as UTC and said one way");
// ---------------------------------------------------------------------------
{
  const { parseDate, formatDate, relativeDate, olderThan } = await import("../lib/dates.ts");
  const stamp = parseDate("2026-09-03 14:05:11");
  check("a SQLite stamp is UTC", stamp?.toISOString() === "2026-09-03T14:05:11.000Z", stamp?.toISOString());
  check("an ISO string is trusted", parseDate("2026-09-03T14:05:11Z")?.getTime() === stamp?.getTime());
  check("garbage is null", parseDate("not a date") === null && parseDate("") === null);
  check("formatDate names the day", /3 Sept? 2026/.test(formatDate("2026-09-03 14:05:11")), formatDate("2026-09-03 14:05:11"));
  const now = "2026-09-03T15:00:00Z";
  check("relative: minutes", relativeDate("2026-09-03 14:56:00", now) === "4 min ago", relativeDate("2026-09-03 14:56:00", now));
  check("relative: hours", relativeDate("2026-09-03 12:00:00", now) === "3 h ago");
  check("relative: yesterday", relativeDate("2026-09-02 15:00:00", now) === "yesterday");
  check("relative: forwards", relativeDate("2026-09-03 17:00:00", now) === "in 2 h");
  check("relative: far back is the date", /2026/.test(relativeDate("2026-01-01 00:00:00", now)));
  check("olderThan", olderThan("2026-09-03 14:00:00", 10, now) && !olderThan("2026-09-03 14:55:00", 10, now));
}

// ---------------------------------------------------------------------------
section("Seams are trimmed, refrains are kept");
// ---------------------------------------------------------------------------
{
  const { joinPassages } = await import("../app/sources/[id]/Reader.tsx");
  const P = (id, text) => ({ id, seq: id, text, locator: "", label: null, extracted: true, mentions: [] });
  const refrain = "And so it goes.";
  const a = "First paragraph of the chapter, long enough to be a paragraph.";
  const b = "Second paragraph, which the chunker will repeat at the next seam.";
  const c = "Third paragraph, new to the second chunk.";
  const blocks = joinPassages([
    P(1, [a, refrain, b].join("\n\n")),
    P(2, [b, c, refrain].join("\n\n")),
    P(3, ["Fourth paragraph, far from any seam.", refrain].join("\n\n")),
  ]);
  const all = blocks.flatMap((x) => x.paragraphs);
  check("the overlap at the seam is dropped once", all.filter((t) => t === b).length === 1);
  check("a refrain inside the seam window is dropped once at the seam", all.filter((t) => t === refrain).length >= 2, String(all.filter((t) => t === refrain).length));
  check("a refrain beyond the seam window is kept", blocks[2].paragraphs.includes(refrain));
  check("nothing else is lost", all.includes(a) && all.includes(c));
}

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
