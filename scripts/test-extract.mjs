/**
 * Extraction quality, and what the newsroom audit asked of it.
 *
 * Verbatim quotes that really are the passage's own text; claims that know
 * who asserted them; entities that keep their labels current; retrieval that
 * does not drop "US" from a question about the US; and a fetch that refuses
 * the machine's own addresses. Runs against a scratch database; no API key
 * and no network.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-extract.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const SANDBOX = path.join(root, "data", "__extract__");
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
const extract = await import("../lib/pipeline/extract.ts");
const { locateQuote, normaliseEventDate, persist, sourceHeader, systemFor, SYSTEM } = extract;
const { looksLikeFrontMatter, matchTag, sampleFor } = await import("../lib/pipeline/tag.ts");
const { queryTerms, retrieve, citationOf } = await import("../lib/pipeline/ask.ts");
const { evidenceFor } = await import("../lib/pipeline/factcheck.ts");
const { evidence, dateSpan } = await import("../lib/pipeline/resolve.ts");
const { isPrivateAddress, isBlockedHost, assertSafeUrl, safeFetch } = await import("../lib/net.ts");
const { canonicalUrl, normaliseLang, toPublishedAt, outletFromUrl } = await import("../lib/ingest/meta.ts");
const { applyMeta } = await import("../lib/ingest/index.ts");

/* ---------------------------------------------------------------- fixtures */

const mkSource = (title, extra = {}) =>
  Number(
    db()
      .prepare(
        "INSERT INTO sources (title, author, kind, status, published_at, year, outlet) VALUES (?, ?, ?, 'ready', ?, ?, ?)"
      )
      .run(title, extra.author ?? null, extra.kind ?? "text", extra.published_at ?? null, extra.year ?? null, extra.outlet ?? null)
      .lastInsertRowid
  );
const mkChunk = (sourceId, seq, text) =>
  Number(
    db()
      .prepare(
        "INSERT INTO chunks (source_id, seq, text, token_est, locator_json, extracted_at) VALUES (?, ?, ?, 100, '{\"page\":3}', datetime('now'))"
      )
      .run(sourceId, seq, text).lastInsertRowid
  );
const mkEntity = (name, type, extra = {}) =>
  Number(
    db()
      .prepare("INSERT INTO entities (type, canonical_name, normalized, disambiguator, name_locked) VALUES (?, ?, ?, ?, ?)")
      .run(type, name, name.toLowerCase(), extra.disambiguator ?? null, extra.locked ? 1 : 0).lastInsertRowid
  );
const mkMention = (entityId, chunkId, sourceId, quote, extra = {}) =>
  Number(
    db()
      .prepare(
        "INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote, claim, context, confidence) VALUES (?,?,?,?,?,?,?,1.0)"
      )
      .run(entityId, chunkId, sourceId, extra.surface ?? "x", quote, extra.claim ?? null, extra.context ?? null).lastInsertRowid
  );
const one = (sql, ...args) => db().prepare(sql).get(...args);

/* ------------------------------------------------------- the quote locator */

section("A stored quote is the passage's own text");
{
  const text =
    "Officials said the tariff would take effect on Monday.\nThe minister,  speaking in Ottawa, denied it.  “We have no such plan,” she said.";

  check("an exact match comes back as written", locateQuote("The minister,  speaking in Ottawa, denied it.", text) === "The minister,  speaking in Ottawa, denied it.");
  check(
    "a quote the model re-wrapped still maps to the original spacing",
    locateQuote("The minister, speaking in Ottawa, denied it.", text) === "The minister,  speaking in Ottawa, denied it.",
    JSON.stringify(locateQuote("The minister, speaking in Ottawa, denied it.", text))
  );
  check(
    "straightened quotation marks still find the curly original",
    locateQuote('"We have no such plan," she said.', text) === "“We have no such plan,” she said."
  );
  check(
    "case differences are tolerated but the passage's case is stored",
    locateQuote("officials said the tariff would take effect on monday.", text) === "Officials said the tariff would take effect on Monday."
  );

  // The audit's F-09: a matching head with a mangled tail used to store the
  // model's tail. Now the stored text runs to the end of the passage's sentence.
  const mangled = locateQuote("Officials said the tariff would take effect on Monday, and then some invented words here.", text);
  check("a mangled tail is replaced by the passage's own sentence end", mangled === "Officials said the tariff would take effect on Monday.", JSON.stringify(mangled));
  check("nothing the model wrote reaches the stored quote", !/invented/.test(mangled ?? ""));

  check("a quote not in the passage is refused", locateQuote("The prime minister resigned that evening.", text) === null);
  check("a fragment too short to be evidence is refused", locateQuote("denied", text) === null);
  check("a mangled head is refused even with a good tail", locateQuote("Ministers stated the tariff would take effect on Monday.", text) === null);
}

section("Event dates arrive sortable");
{
  check("a bare year", normaliseEventDate({ dateIso: "1956" }).dateIso === "1956");
  check("an unpadded month is padded", normaliseEventDate({ dateIso: "1956-3" }).dateIso === "1956-03");
  check("a full date", normaliseEventDate({ dateIso: "2026-3-4", precision: "day" }).dateIso === "2026-03-04");
  check('"unknown" as a date becomes null', normaliseEventDate({ dateIso: "unknown" }).dateIso === null);
  check("and its precision is unknown", normaliseEventDate({ dateIso: "unknown", precision: "day" }).precision === "unknown");
  check("precision cannot claim more than the date carries", normaliseEventDate({ dateIso: "1956", precision: "day" }).precision === "year");
  check("a precision outside the enum is derived instead", normaliseEventDate({ dateIso: "1956-03", precision: "century" }).precision === "month");
  check("decade is kept when given", normaliseEventDate({ dateIso: "1950", precision: "decade" }).precision === "decade");
  check("circa is tolerated", normaliseEventDate({ dateIso: "c. 1744" }).dateIso === "1744");
}

/* ------------------------------------------------------------- the prompt */

section("What the extractor is told");
{
  const header = sourceHeader(
    { title: "Tariff talks stall", author: "J. Doe", publisher: null, outlet: "The Globe and Mail", published_at: "2026-03-04T14:00:00Z", year: "2026", dateline: "OTTAWA", kind: "url" },
    "p. 3"
  );
  check("the header names the outlet", /outlet: The Globe and Mail/.test(header));
  check("and the author", /author: J\. Doe/.test(header));
  check("and the published date with its weekday", /published: 2026-03-04T14:00:00Z \(Wednesday\)/.test(header), header);
  check("and the dateline", /dateline: OTTAWA/.test(header));
  check("a web source is an article", /kind: article/.test(header));
  check("a book with only a year says so", /published: 1991$/m.test(sourceHeader({ title: "T", author: null, publisher: "Knopf", outlet: null, published_at: null, year: "1991", dateline: null, kind: "epub" })));
  check("and is a book", /kind: book/.test(sourceHeader({ title: "T", author: null, publisher: null, outlet: null, published_at: null, year: null, dateline: null, kind: "epub" })));
  check("no date at all is said plainly", /published: unknown/.test(sourceHeader({ title: "T", author: null, publisher: null, outlet: null, published_at: null, year: null, dateline: null, kind: "text" })));

  check("the rules resolve relative dates against the published date", /Resolve relative dates against the published date/.test(SYSTEM));
  check("the rules define the seven types", ["- person:", "- org:", "- institution:", "- place:", "- event:", "- work:", "- concept:"].every((t) => SYSTEM.includes(t)));
  check("the rules ask for attribution and claim kind", /"attribution"/.test(SYSTEM) && /"claimKind"/.test(SYSTEM));
  check("disambiguators are written in the interface language", /Write\s+"disambiguator" in English/.test(SYSTEM));
  check("and follow the setting", /"disambiguator" in Arabic/.test(systemFor("ar")));
  check("the verbatim rule still stands", /Quote VERBATIM/.test(SYSTEM));
  check("the schema carries the new fields", Boolean(extract.SCHEMA.properties.entities.items.properties.attribution) && Boolean(extract.SCHEMA.properties.entities.items.properties.claimKind));
  check(
    "the context description is two sentences",
    extract.SCHEMA.properties.entities.items.properties.context.description.split(/(?<=\.)\s+/).length <= 2
  );
}

/* ------------------------------------------------------------- persisting */

section("Persisting an extraction");
const src = mkSource("Tariff talks stall", { kind: "url", published_at: "2026-03-04T14:00:00Z", year: "2026", outlet: "The Globe and Mail", author: "J. Doe" });
{
  const text =
    "Officials said the tariff would take effect on Monday. Finance Minister Freeland denied that Canada had agreed to anything. Freeland met Yellen in Ottawa on Tuesday.";
  const chunk = { id: mkChunk(src, 0, text), source_id: src, text };
  const result = persist(chunk, {
    entities: [
      { surface: "Freeland", type: "person", quote: "Finance Minister Freeland denied that Canada had agreed to anything.", claim: "Denied agreement", attribution: "Finance Minister Freeland", claimKind: "denial", disambiguator: "Canadian finance minister" },
      { surface: "Canada", type: "place", quote: "Officials said the tariff would take effect on Monday, and more besides.", attribution: "unnamed officials", claimKind: "forecast" },
      { surface: "Yellen", type: "person", quote: "Freeland met Yellen in Ottawa on Tuesday.", claimKind: "not-a-kind" },
      { surface: "Nobody", type: "person", quote: "This sentence is not in the passage at all." },
    ],
    relations: [
      { from: "Freeland", to: "Yellen", type: "met with", quote: "Freeland met Yellen in Ottawa on Tuesday." },
      { from: "Freeland", to: "Canada", type: "serves", quote: "Freeland runs Canada's finances, it says here." },
      { from: "Yellen", to: "Canada", type: "visited" },
    ],
    events: [{ entity: "Freeland", dateText: "on Tuesday", dateIso: "2026-3-3", precision: "day", summary: "Met Yellen" }],
  });

  check("three quotes land, the fabricated one does not", result.mentions === 3, `${result.mentions}`);
  const freeland = one("SELECT m.*, e.disambiguator FROM mentions m JOIN entities e ON e.id=m.entity_id WHERE m.surface='Freeland'");
  check("attribution is stored", freeland.attribution === "Finance Minister Freeland");
  check("claim kind is stored", freeland.claim_kind === "denial");
  check("the disambiguator is stored on a new entity", freeland.disambiguator === "Canadian finance minister");
  const canada = one("SELECT * FROM mentions WHERE surface='Canada'");
  check("a mangled tail is stored as the passage's sentence", canada.quote === "Officials said the tariff would take effect on Monday.", canada.quote);
  check("anonymous attribution is kept as the text put it", canada.attribution === "unnamed officials");
  check("a claim kind outside the enum is dropped, not stored", one("SELECT claim_kind FROM mentions WHERE surface='Yellen'").claim_kind === null);

  check("a relation with a verbatim quote is kept", Boolean(one("SELECT 1 AS x FROM relations WHERE type='met with'")));
  check("a relation with a fabricated quote is dropped", !one("SELECT 1 AS x FROM relations WHERE type='serves'"));
  check("a relation with no quote is kept, as before", Boolean(one("SELECT 1 AS x FROM relations WHERE type='visited'")));
  check("relations written", result.relations === 2, `${result.relations}`);

  const ev = one("SELECT * FROM events WHERE summary='Met Yellen'");
  check("the event date is padded to ISO", ev.date_iso === "2026-03-03", ev.date_iso);
  check("and its precision agrees", ev.precision === "day");
}

section("Entities keep the best disambiguator they have been offered");
{
  const text = "Chrystia Freeland, Canada's finance minister from 2020 to 2024, spoke at length.";
  const chunk = { id: mkChunk(src, 1, text), source_id: src, text };
  persist(chunk, {
    entities: [{ surface: "Freeland", type: "person", quote: text, disambiguator: "Canadian finance minister 2020-2024, later opposition figure" }],
    relations: [],
    events: [],
  });
  const row = one("SELECT disambiguator FROM entities WHERE canonical_name='Freeland'");
  check("a longer, more specific disambiguator replaces the first", row.disambiguator === "Canadian finance minister 2020-2024, later opposition figure", row.disambiguator);

  persist({ id: mkChunk(src, 2, text), source_id: src, text }, {
    entities: [{ surface: "Freeland", type: "person", quote: text, disambiguator: "Canadian politician" }],
    relations: [],
    events: [],
  });
  check("a shorter one does not", one("SELECT disambiguator FROM entities WHERE canonical_name='Freeland'").disambiguator.startsWith("Canadian finance minister 2020"));

  const locked = mkEntity("Locked Person", "person", { disambiguator: "mine", locked: true });
  db().prepare("INSERT INTO aliases (entity_id, surface, normalized) VALUES (?, 'Locked Person', 'locked person')").run(locked);
  const t2 = "Locked Person appeared at the hearing on the third day of testimony.";
  persist({ id: mkChunk(src, 3, t2), source_id: src, text: t2 }, {
    entities: [{ surface: "Locked Person", type: "person", quote: t2, disambiguator: "a much longer and more specific label than mine" }],
    relations: [],
    events: [],
  });
  check("a name you locked keeps its disambiguator", one("SELECT disambiguator FROM entities WHERE id=?", locked).disambiguator === "mine");
}

section("Twins from an identity split: new evidence lands with its own source");
{
  // Two live entities with the same key and type, as identity splits create.
  const a = mkEntity("Barak Ravid", "person", { disambiguator: "Axios reporter" });
  const b = mkEntity("Barak Ravid", "person", { disambiguator: "a different Barak Ravid" });
  const other = mkSource("Another book", { year: "2019" });
  const otherChunk = mkChunk(other, 0, "Barak Ravid wrote that.");
  // b has more evidence overall; a has evidence in the source being extracted.
  mkMention(b, otherChunk, other, "Barak Ravid wrote that.");
  mkMention(b, otherChunk, other, "Barak Ravid wrote that again.");
  mkMention(b, otherChunk, other, "Barak Ravid wrote that a third time.");
  const here = mkChunk(src, 4, "Barak Ravid reported the call.");
  mkMention(a, here, src, "Barak Ravid reported the call.");

  const t = "Barak Ravid reported a second call between the two leaders.";
  persist({ id: mkChunk(src, 5, t), source_id: src, text: t }, {
    entities: [{ surface: "Barak Ravid", type: "person", quote: t }],
    relations: [],
    events: [],
  });
  check(
    "the twin already holding evidence from this source wins",
    one("SELECT entity_id FROM mentions WHERE quote=?", t).entity_id === a,
    `landed on ${one("SELECT entity_id FROM mentions WHERE quote=?", t).entity_id}, wanted ${a}`
  );

  const third = mkSource("A third source", { year: "2021" });
  const t3 = "Barak Ravid was cited by name in the third source.";
  persist({ id: mkChunk(third, 0, t3), source_id: third, text: t3 }, {
    entities: [{ surface: "Barak Ravid", type: "person", quote: t3 }],
    relations: [],
    events: [],
  });
  check("with no evidence in the source, the twin with most evidence wins", one("SELECT entity_id FROM mentions WHERE quote=?", t3).entity_id === b);
}

/* ---------------------------------------------------------------- tagging */

section("Filing reads the book, not its copyright page");
{
  const copyright = "Copyright © 2019 by Someone\nAll rights reserved.\nISBN 978-0-00-000000-0\nPublished by Example House\nFirst edition\n";
  const contents = Array.from({ length: 12 }, (_, i) => `Chapter ${i + 1}  The Something of Something  ${10 + i * 20}`).join("\n");
  const prose = "The Free Officers Movement was formed in Cairo in 1949 by a small circle of army officers who had served in Palestine. Nasser was its founding chairman. He drew up the first list of members and set its early direction, which is where this account begins.";
  check("a copyright page is front matter", looksLikeFrontMatter(copyright));
  check("a contents list is front matter", looksLikeFrontMatter(contents));
  check("prose is not", !looksLikeFrontMatter(prose));
  check("a news lede is not", !looksLikeFrontMatter("OTTAWA — Canada will retaliate against U.S. tariffs, the finance minister said on Tuesday. The measures take effect Monday."));

  const book = mkSource("A Book", { kind: "epub" });
  mkChunk(book, 0, copyright);
  mkChunk(book, 1, contents);
  mkChunk(book, 2, prose);
  mkChunk(book, 3, `${prose} Second passage.`);
  const sample = sampleFor(book);
  check("the sample skips the front matter", !/ISBN/.test(sample) && !/Chapter 7/.test(sample), sample.slice(0, 60));
  check("and opens on the prose", sample.startsWith("The Free Officers"));

  const onlyJunk = mkSource("Only Junk", { kind: "epub" });
  mkChunk(onlyJunk, 0, copyright);
  check("a source with nothing but front matter still gets a sample", sampleFor(onlyJunk).includes("Copyright"));

  const known = [
    { id: 1, name: "Egypt" },
    { id: 2, name: "US Politics" },
    { id: 3, name: "Middle Eastern History" },
    { id: 4, name: "Trade policy" },
  ];
  check("an exact name matches", matchTag("Egypt", known) === 1);
  check("case and punctuation are ignored", matchTag("U.S. Politics", known) === 2);
  check("a leading article is ignored", matchTag("The Middle Eastern History", known) === 3);
  check("a doubled letter within the trigram threshold matches", matchTag("Middle Eastern Historyy", known) === 3);
  check("a qualifier in brackets is set aside", matchTag("Egypt (modern)", known) === 1);
  check("a different topic does not", matchTag("Defence policy", known) === undefined);
  check("an empty name matches nothing", matchTag("  ", known) === undefined);
}

/* -------------------------------------------------------------- retrieval */

section("A question about the US keeps the US in it");
{
  check("upper-case two-letter terms survive", queryTerms("What is the US Canada trade dispute about").includes("US"));
  check("so do UN and EU", queryTerms("How did the UN and the EU respond to the sanctions").filter((t) => t === "UN" || t === "EU").length === 2);
  check("a lower-case two-letter word in a long question is still dropped", !queryTerms("tell me everything about the war in Iraq and its aftermath").includes("in"));
  check("but every word of a short question counts", queryTerms("oil in Iraq").includes("in"));
  check("stop words still go", !queryTerms("What did Nasser say about Suez").includes("What"));
  check("the stray Russian stop word is gone", queryTerms("что говорил Насер").includes("что"));
}

section("The entity pass ranks by relevance and recency, not by entity size");
{
  const big = mkEntity("United States", "place");
  const oldSrc = mkSource("An old book", { year: "1991" });
  const newSrc = mkSource("This morning's article", { kind: "url", published_at: "2026-09-01T08:00:00Z", year: "2026", outlet: "Reuters", author: "R. Writer" });
  // Forty passages on one entity, none of which the question's words match:
  // the entity pass is the only way they can reach the answer.
  for (let i = 0; i < 40; i++) {
    const c = mkChunk(oldSrc, 10 + i, `The country did something unrelated number ${i} in that year.`);
    mkMention(big, c, oldSrc, `The country did something unrelated number ${i} in that year.`);
  }
  const relevant = mkChunk(newSrc, 0, "The United States imposed steel tariffs on Canada this morning.");
  const relevantId = mkMention(big, relevant, newSrc, "The United States imposed steel tariffs on Canada this morning.");
  const small = mkEntity("Steelworkers Union", "org");
  const smallChunk = mkChunk(newSrc, 1, "The Steelworkers Union welcomed the decision on tariffs.");
  const smallId = mkMention(small, smallChunk, newSrc, "The Steelworkers Union welcomed the decision on tariffs.");

  const hits = retrieve("United States Steelworkers Union tariffs", undefined, 60);
  const ids = hits.map((h) => h.id);
  check("the relevant passage about the big entity comes first among its own", ids.indexOf(relevantId) >= 0 && ids.indexOf(relevantId) < 3, `at ${ids.indexOf(relevantId)}`);
  check("the small entity is not crowded out", ids.includes(smallId));
  const fromBig = hits.filter((h) => h.entity === "United States").length;
  check("the entity pass hands over at most fifteen passages for one entity", fromBig <= 15, `${fromBig}`);
  check("and it does hand some over", fromBig >= 10, `${fromBig}`);

  const dated = hits.find((h) => h.id === relevantId);
  check("passages carry their outlet and date", dated.outlet === "Reuters" && dated.published?.startsWith("2026-09-01"));
  check("the citation line shows outlet, author and date", /Reuters, R\. Writer, 2026-09-01/.test(citationOf(dated)), citationOf(dated));

  const recent = retrieve("United States", undefined, 60, { since: "2026-01-01" });
  check("a since filter keeps only dated, recent passages", recent.length > 0 && recent.every((h) => h.published?.startsWith("2026")), `${recent.length}`);
  const older = retrieve("United States", undefined, 60, { until: "2000-12-31" });
  check("an until filter keeps the old book", older.length > 0 && older.every((h) => h.published === "1991"), `${older.length}`);
  const scoped = retrieve("United States tariffs", undefined, 60, { sourceIds: [newSrc] });
  check("a source filter keeps only that source", scoped.length > 0 && scoped.every((h) => h.source === "This morning's article"));
  check("a malformed date filter is ignored rather than applied", retrieve("United States", undefined, 60, { since: "yesterday" }).length >= 15);
}

section("Fact-check retrieves per claim");
{
  const union = evidenceFor(["The United States imposed steel tariffs on Canada", "The Steelworkers Union welcomed the decision"]);
  const ids = new Set(union.map((p) => p.id));
  check("evidence for each claim is present", union.some((p) => p.entity === "United States") && union.some((p) => p.entity === "Steelworkers Union"));
  check("each passage appears once", ids.size === union.length);
  check("the union stays within the cap", union.length <= 60);
  check("no claims, no evidence", evidenceFor([]).length === 0);
}

/* ---------------------------------------------------------------- resolve */

section("The adjudicator sees the richest evidence and the dates");
{
  const e = mkEntity("Pierre Trudeau", "person");
  const s1 = mkSource("Old profile", { year: "1972" });
  const s2 = mkSource("Retrospective", { kind: "url", published_at: "2000-10-01T00:00:00Z", year: "2000" });
  const c1 = mkChunk(s1, 0, "Trudeau said so.");
  mkMention(e, c1, s1, "Trudeau said so.");
  mkMention(e, c1, s1, "Trudeau, then prime minister, told the House that the War Measures Act would be invoked.", { claim: "Invoked the act", context: "the October Crisis, 1970" });
  const discarded = mkMention(e, mkChunk(s2, 0, "x"), s2, "A discarded passage about Trudeau that must not be shown to the adjudicator at all.");
  db().prepare("UPDATE mentions SET discarded_at=datetime('now') WHERE id=?").run(discarded);
  mkMention(e, mkChunk(s2, 1, "y"), s2, "Trudeau died in 2000.");

  const ev = evidence(e);
  check("the quote with a claim and a context comes first", ev.startsWith('"Trudeau, then prime minister'), ev.slice(0, 60));
  check("its context is shown", /about: the October Crisis/.test(ev));
  check("a discarded passage is not shown", !/discarded passage/.test(ev));
  check("the date span covers both sources", dateSpan(e) === "1972 to 2000-10-01", dateSpan(e));
  check("an undated entity says so", dateSpan(mkEntity("Nobody Dated", "person")) === "undated");
}

/* ------------------------------------------------------------------ net */

section("Fetching refuses the machine's own addresses");
{
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.5", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255"]) {
    check(`${ip} is private`, isPrivateAddress(ip));
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "104.16.0.1"]) check(`${ip} is public`, !isPrivateAddress(ip));
  for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "ff02::1"]) {
    check(`${ip} is private`, isPrivateAddress(ip));
  }
  check("a public IPv6 is public", !isPrivateAddress("2606:4700::1111"));
  check("garbage is treated as private", isPrivateAddress("not-an-ip"));
  check("localhost is blocked", isBlockedHost("localhost") && isBlockedHost("foo.localhost") && isBlockedHost("LOCALHOST."));
  check("the metadata host is blocked", isBlockedHost("metadata.google.internal"));

  const refused = async (url) => {
    try {
      await assertSafeUrl(url);
      return false;
    } catch (err) {
      return err.name === "UnsafeUrlError";
    }
  };
  check("file: is refused", await refused("file:///etc/passwd"));
  check("ftp: is refused", await refused("ftp://example.com/x"));
  check("a loopback literal is refused", await refused("http://127.0.0.1:5400/api/settings"));
  check("an IPv6 loopback literal is refused", await refused("http://[::1]:5400/"));
  check("a private literal is refused", await refused("http://10.0.0.5/"));
  check("localhost is refused", await refused("http://localhost:5400/"));
  check("credentials in the URL are refused", await refused("http://user:pw@example.com/"));
  check("an unparseable URL is refused", await refused("not a url"));
  check("safeFetch refuses before touching the network", await safeFetch("http://169.254.169.254/latest/meta-data/").then(() => false, (e) => e.name === "UnsafeUrlError"));
}

/* -------------------------------------------------------------- metadata */

section("Source metadata is normalised on the way in");
{
  check("tracking parameters are stripped", canonicalUrl("https://WWW.Example.com/story?utm_source=x&id=5&fbclid=abc#top") === "https://www.example.com/story?id=5");
  check("the host is lower-cased and the fragment dropped", canonicalUrl("HTTPS://News.Example.COM/a/b/#frag") === "https://news.example.com/a/b");
  check("a declared canonical wins", canonicalUrl("https://example.com/amp/story?utm_medium=y", "https://example.com/story") === "https://example.com/story");
  check("a relative canonical resolves against the page", canonicalUrl("https://example.com/amp/story", "/story") === "https://example.com/story");
  check("a non-http canonical is ignored", canonicalUrl("https://example.com/story", "javascript:void(0)") === "https://example.com/story");
  check("a non-http URL is null", canonicalUrl("file:///x") === null);
  check("query order is stable", canonicalUrl("https://e.com/?b=2&a=1") === canonicalUrl("https://e.com/?a=1&b=2"));

  check('"En" → "en"', normaliseLang("En") === "en");
  check('"eng" → "en"', normaliseLang("eng") === "en");
  check('"en-US" → "en"', normaliseLang("en-US") === "en");
  check('"ar-EG" → "ar"', normaliseLang("ar-EG") === "ar");
  check('"ara" → "ar"', normaliseLang("ara") === "ar");
  check('"English" → "en"', normaliseLang("English") === "en");
  check("empty is null", normaliseLang("") === null && normaliseLang(null) === null);
  check("junk is null", normaliseLang("???") === null);

  check("a full timestamp is kept as ISO", toPublishedAt("2026-03-04T14:00:00+02:00") === "2026-03-04T12:00:00.000Z");
  check("a bare date stays a date", toPublishedAt("2026-03-04") === "2026-03-04");
  check("a bare year stays a year", toPublishedAt("1991") === "1991");
  check("an RFC 2822 date parses", toPublishedAt("Wed, 04 Mar 2026 14:00:00 GMT") === "2026-03-04T14:00:00.000Z");
  check("nonsense is null", toPublishedAt("last Tuesday") === null);
  check("the outlet falls back to the host without www", outletFromUrl("https://www.theglobeandmail.com/politics/x") === "theglobeandmail.com");

  const s = mkSource("Pasted", { kind: "text" });
  applyMeta(s, { lang: "en-US", publishedAt: "2026-03-04T14:00:00Z", outlet: "CBC", section: "Politics", canonicalUrl: "https://cbc.ca/x" });
  const row = one("SELECT * FROM sources WHERE id=?", s);
  check("lang is stored as a primary tag", row.lang === "en");
  check("published_at is stored in full", row.published_at === "2026-03-04T14:00:00.000Z", row.published_at);
  check("year follows from it", row.year === "2026");
  check("outlet, section and canonical url are stored", row.outlet === "CBC" && row.section === "Politics" && row.canonical_url === "https://cbc.ca/x");
  applyMeta(s, { lang: "", outlet: "", publishedAt: "not a date", title: "" });
  const again = one("SELECT * FROM sources WHERE id=?", s);
  check("an empty or unreadable value leaves the record alone", again.lang === "en" && again.outlet === "CBC" && again.published_at.startsWith("2026") && again.title === "Pasted");
  applyMeta(s, { lang: "Ara", outlet: "Other" });
  const later = one("SELECT * FROM sources WHERE id=?", s);
  check("a later value replaces, normalised", later.lang === "ar" && later.outlet === "Other");
}

// Windows keeps the database handle open until exit, so the scratch directory
// is removed on the next run's start instead when this fails.
try {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
} catch {
  /* removed at the next start */
}
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
