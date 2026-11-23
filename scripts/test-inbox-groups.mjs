/**
 * The inbox's "Group related" pass.
 *
 * Deterministic and idempotent; strips an outlet's furniture before it
 * compares; groups on the same wire copy, on alike headlines, and on shared
 * names and figures — never on headline words alone, never on one shared
 * name; keeps a story you named.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-inbox-groups.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_inbox_groups__");
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
const G = await import("../lib/inbox-groups.ts");

section("What makes an article specific");
{
  const t = G.specificTokens(
    "Rep. Thomas Massie, R-KY, moved to impeach Defense Secretary Pete Hegseth on Tuesday over the Iran war. Massie said the $42 billion bill was unlawful. They disagreed. The vote was 232-147 and 55,000 people watched."
  );
  check("a run of capitalised words is one name", t.has("thomas massie"), [...t].join(" | "));
  check("and every two-word window of a longer one, titles dropped", t.has("pete hegseth") && t.has("defense pete") && !t.has("secretary pete"), [...t].join(" | "));
  check("a surname the text uses mid-sentence counts alone", t.has("massie"));
  check("a sentence opener that is never a name does not", !t.has("they"));
  check("money, a vote and a big number are figures", t.has("$42 billion") && t.has("232-147") && t.has("55,000"));
  check("a bare year is not", !G.specificTokens("In 2026 the vote came.").has("2026"));
  const w = G.titleWordTokens("Massie moves to impeach Pete Hegseth over Iran war");
  check("headline words are marked as the weaker kind", w.has("~impeach") && !w.has("~over"), [...w].join(" "));
  check("the headline is taken off the top of a lede that repeats it", G.withoutTitle("Massie launches effort to impeach Hegseth Rep. Thomas Massie on Tuesday…", "Massie launches effort to impeach Hegseth").startsWith("Rep. Thomas"));
  const ind = G.independent(["fbi director kash patel", "kash patel", "patel", "~patel", "~polls", "senate judiciary"]);
  check("sub-phrases of a shared name are one thing", ind.length === 3 && ind.includes("fbi director kash patel") && ind.includes("senate judiciary") && ind.includes("~polls"), ind.join(" | "));
}

section("An outlet's furniture is not evidence");
{
  const chrome = "Now Playing UP NEXT Robert Kraft Defends Dropping Macklemore From Ed Sheeran Tour 03:10 Kennedy Center board votes to close venue. ";
  const furniture = () => [1, 2, 3, 4].map((i) => ({ title: `Other ${i}`, lede: `${chrome}Story ${i} about Something Else ${i}.` }));
  const acc = (sourceId, outlet, title, lede, at = "2026-09-15T10:00:00Z") => ({ sourceId, storyId: null, namedBy: null, title, outlet, at, lede, summary: "" });
  const a = acc(1, "NBC", "FBI Director Patel clashes with lawmakers", `${chrome}FBI Director Kash Patel clashed with senators on the Senate Judiciary Committee on Tuesday. Patel defended the bureau.`);
  const b = acc(2, "NBC", "Kennedy Center to close for renovations", `${chrome}The Kennedy Center board voted to close the venue. Trustees said the Kennedy Center needed work.`);
  const sk = G.sketchAccounts([a, b], { furniture: () => furniture() });
  check("the chrome's names are stripped", !sk[0].tokens.has("ed sheeran") && !sk[1].tokens.has("ed sheeran"), [...sk[0].tokens].join(" | "));
  check("the article's own names survive", sk[0].tokens.has("kash patel") && sk[0].tokens.has("judiciary"), [...sk[0].tokens].join(" | "));
  check("two NBC pages sharing only chrome are not a pair", G.relatedPairs(sk).length === 0, JSON.stringify(G.relatedPairs(sk)));
}

section("What groups and what does not");
{
  const at = (h) => new Date(Date.UTC(2026, 8, 15, 10 + h)).toISOString();
  const acc = (sourceId, outlet, title, lede, h = 0, extra = {}) => ({ sourceId, storyId: null, namedBy: null, title, outlet, at: at(h), lede, summary: "", ...extra });
  const none = () => [];
  const accounts = [
    acc(1, "Axios", "Massie moves to impeach Pete Hegseth over Iran War", "Rep. Thomas Massie, R-Ky., moved on Tuesday to impeach Defense Secretary Pete Hegseth over the Iran war, citing the War Powers Resolution."),
    acc(2, "The Washington Post", "Republican lawmaker moves to force vote on impeaching Hegseth", "Rep. Thomas Massie argued the defense secretary Pete Hegseth had violated three provisions of the War Powers Resolution of 1973 in the conflict with Iran.", 1),
    acc(3, "The Hill", "GOP leaders throw cold water on AI regulation despite apocalyptic industry warnings", "Speaker Mike Johnson said Congress would not rush. Industry leaders had warned of catastrophe.", 2),
    acc(4, "BBC News", "Why Trump is all-in on AI despite the warnings", "The president has dismissed the warnings from Anthropic and OpenAI as a hoax, aides said.", 3),
    acc(5, "Politico", "Iran war has cost taxpayers $38B — and counting", "The Congressional Budget Office said on Tuesday the war has cost $38 billion, with $2 billion to $3 billion more each month.", 1),
    acc(6, "CBS News", "Iran War could cost $2 billion per month, Congressional Budget Office estimates", "A Congressional Budget Office report put the cost at $38 billion so far and $2 billion to $3 billion a month.", 2),
    acc(7, "Reuters", "Talks resume in Oman", "Gulf officials met Iranian diplomats in Muscat, Oman on Sunday, three people familiar with the talks said. The talks in Oman had stalled.", 0),
    acc(8, "AP", "Gulf states reopen channel to Tehran", "Gulf officials met Iranian diplomats in Muscat, Oman on Sunday, three people familiar with the talks said. The talks in Oman had stalled. Saudi Arabia sent its deputy minister.", 4),
    acc(9, "Bloomberg", "Bessent Says He’ll Meet Chinese Counterpart", "Treasury Secretary Scott Bessent said he will meet He Lifeng this weekend.", 0),
    acc(10, "Bloomberg", "Bessent Says He’s Supportive of $5,000 Checks", "Treasury Secretary Scott Bessent said he supports the plan for $5,000 checks.", 1),
    acc(11, "The Hill", "Talks resume in Oman", "A column about something else entirely, mentioning nobody in particular.", 200),
  ];
  const sk = G.sketchAccounts(accounts, { furniture: none });
  const pairs = G.relatedPairs(sk);
  const has = (x, y) => pairs.some((p) => (p.a === x && p.b === y) || (p.a === y && p.b === x));
  const why = (x, y) => pairs.find((p) => (p.a === x && p.b === y) || (p.a === y && p.b === x))?.why;
  check("two accounts of one impeachment move are a pair, on names", has(1, 2) && why(1, 2) === "tokens", JSON.stringify(pairs));
  check("two AI pieces sharing only headline words are not", !has(3, 4), JSON.stringify(pairs.filter((p) => p.a === 3 || p.b === 3)));
  check("two accounts of one CBO report are a pair, on figures", has(5, 6), JSON.stringify(pairs));
  check("the same wire copy under two headlines is a pair", has(7, 8) && why(7, 8) === "wire");
  check("two Bessent items sharing only his name are not", !has(9, 10));
  check("an alike headline three weeks apart is not", !has(7, 11));
  check("nothing pairs with itself or twice", new Set(pairs.map((p) => `${p.a}-${p.b}`)).size === pairs.length && pairs.every((p) => p.a < p.b));

  // Deterministic: the same inbox in a different order gives the same pairs.
  const again = G.relatedPairs(G.sketchAccounts([...accounts].reverse(), { furniture: none }));
  const key = (ps) => ps.map((p) => `${Math.min(p.a, p.b)}-${Math.max(p.a, p.b)}`).sort().join(",");
  check("the pairs do not depend on the order read", key(again) === key(pairs), `${key(again)} vs ${key(pairs)}`);
}


section("The model proposes, the rules dispose");
{
  const at = (h) => new Date(Date.UTC(2026, 8, 15, 10 + h)).toISOString();
  const acc = (sourceId, storyId, title, h) => ({ sourceId, storyId, namedBy: storyId ? "auto" : null, title, outlet: "O", at: at(h), lede: "", summary: "" });
  const accounts = [acc(1, 50, "Court lifts cloud over midterms", 0), acc(2, 50, "Supreme Court rejects ballot curbs", 1), acc(3, null, "Trump slams justices over ballots", 2), acc(4, null, "Bond yields hit 5%", 3), acc(5, 60, "A", 0), acc(6, 60, "B", 1), acc(7, null, "Very old", -300)];
  const { lines, storyRep } = G.headlineLines(accounts);
  check("a story with several held accounts is one S line", lines.filter((l) => l.startsWith("S50")).length === 1 && lines.some((l) => l.startsWith("S60")), lines.join(" / "));
  check("lone headlines are I lines with outlet and time", lines.some((l) => /^I3: Trump slams justices over ballots — O, 09-15 12:00$/.test(l)), lines.join(" / "));
  check("the S line says how many accounts", lines.find((l) => l.startsWith("S50")).includes("2 accounts"));
  const r = G.pairsFromModel(accounts, storyRep, [
    { label: "mail ballots", ids: ["S50", "I3"] },
    { label: "nonsense", ids: ["I4"] },
    { label: "two stories", ids: ["S50", "S60"] },
    { label: "unknown ids", ids: ["I999", "X1", "I4"] },
    { label: "too far apart", ids: ["I7", "I4"] },
  ]);
  check("a lone headline attached to a story becomes a pair with that story's account", r.pairs.length === 1 && r.pairs[0].a === 1 && r.pairs[0].b === 3, JSON.stringify(r.pairs));
  check("a one-member group, two stories, unknown ids and a stale pair are refused", r.accepted === 1, String(r.accepted));
  const big = G.pairsFromModel(accounts, storyRep, [{ ids: Array.from({ length: 12 }, (_, i) => "I" + (i + 1)) }]);
  check("an oversized group is refused", big.accepted === 0);
  const empty = await G.regroupByHeadlines({ timeoutMs: 5000 });
  check("an empty inbox never reaches the model", empty.model === null && empty.error === null && empty.grouped === 0, JSON.stringify(empty));
}


section("Bundles: the subject level");
{
  const B = await import("../lib/inbox-bundles.ts");
  const at = (h) => new Date(Date.UTC(2026, 8, 15, 10 + h)).toISOString();
  const item = (itemId, storyId, title, h, bundle = null) => ({ itemId, sourceId: itemId + 100, storyId, title, outlet: "O", at: at(h), bundle });
  const items = [item(1, 7, "Court lifts cloud", 0), item(2, 7, "Court rejects curbs", 1, "Mail ballots"), item(3, null, "Bond yields hit 5%", 2), item(4, null, "Quebec debate tonight", 3)];
  const { lines, membersOf } = B.bundleLines(items);
  check("a story with several accounts is one line carrying all its items", lines.some((l) => l.startsWith("S7:") && l.includes("2 accounts")) && membersOf.get("S7").length === 2, lines.join(" / "));
  check("a line shows the bundle it is in now", lines.find((l) => l.startsWith("S7")).includes("[now: Mail ballots]"));
  check("lone items are their own lines", membersOf.get("I3")?.[0] === 3 && membersOf.get("I4")?.[0] === 4);
  const a = B.assignmentsFromModel(membersOf, [
    { label: "Mail ballots", ids: ["S7"] },
    { label: "  Markets  ", ids: ["I3", "I999", "X"] },
    { label: "", ids: ["I4"] },
    { label: "Markets", ids: ["I3"] },
  ]);
  check("a story's accounts all land in its bundle", JSON.stringify(a.get("Mail ballots")) === "[1,2]", JSON.stringify([...a]));
  check("labels are trimmed and unknown ids dropped", JSON.stringify(a.get("Markets")) === "[3]", JSON.stringify([...a]));
  check("an unlabelled bundle is ignored and an item is placed once", a.size === 2 && [...a.values()].flat().length === 3);
  const empty = await B.bundleInbox({ timeoutMs: 5000 });
  check("an empty inbox never reaches the model", empty.model === null && empty.error === null && empty.assigned === 0, JSON.stringify(empty));
  check("with no bundles the event pass asks nothing", (await B.groupEventsInBundles()).asked === 0);
}

section("One bundle's accounts, without reading the whole inbox");
{
  const feedId = Number(db().prepare("INSERT INTO feeds (url, title, outlet) VALUES ('https://b.example/rss', 'Paper', 'Paper')").run().lastInsertRowid);
  const bundle = (label) => Number(db().prepare("INSERT INTO inbox_bundles (label) VALUES (?)").run(label).lastInsertRowid);
  const held = (name, bundleId, state = "held") => {
    const sourceId = Number(
      db().prepare("INSERT INTO sources (title, kind, url, status, triage) VALUES (?, 'url', ?, 'chunked', 'held')").run(name, `https://b.example/${name}`).lastInsertRowid
    );
    db().prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, ?, '{}')").run(sourceId, `The lede of ${name}.`);
    const itemId = Number(
      db().prepare("INSERT INTO feed_items (feed_id, guid, url, title, state, source_id) VALUES (?, ?, ?, ?, ?, ?)").run(feedId, name, `https://b.example/${name}`, name, state, sourceId).lastInsertRowid
    );
    if (bundleId) db().prepare("INSERT INTO inbox_bundle_items (item_id, bundle_id) VALUES (?, ?)").run(itemId, bundleId);
    return sourceId;
  };
  const courts = bundle("Courts");
  const markets = bundle("Markets");
  const a = held("court-one", courts);
  const b = held("court-two", courts);
  const c = held("market-one", markets);
  held("unbundled", null);
  held("court-decided", courts, "kept");

  const ids = (list) => list.map((x) => x.sourceId).sort((x, y) => x - y).join(",");
  check("the whole inbox is still the whole inbox", G.heldAccounts().length === 4, String(G.heldAccounts().length));
  check("a bundle gets only its own held accounts", ids(G.heldAccounts(courts)) === [a, b].sort((x, y) => x - y).join(","), ids(G.heldAccounts(courts)));
  check("and the other bundle only its", ids(G.heldAccounts(markets)) === String(c), ids(G.heldAccounts(markets)));
  check("with the lede the pass reads", G.heldAccounts(markets)[0].lede === "The lede of market-one.");
  check("an empty bundle has none", G.heldAccounts(bundle("Empty")).length === 0);

  const plan = db()
    .prepare("EXPLAIN QUERY PLAN SELECT id FROM sources WHERE (canonical_url IS NOT NULL AND canonical_url = ?) OR (url IS NOT NULL AND url = ?) LIMIT 1")
    .all("x", "y")
    .map((r) => r.detail)
    .join("; ");
  check("the duplicate check looks a headline up instead of scanning the library", !/SCAN sources/.test(plan), plan);

  db().prepare("DELETE FROM feed_items WHERE feed_id = ?").run(feedId);
  db().prepare("DELETE FROM sources WHERE url LIKE 'https://b.example/%'").run();
  db().prepare("DELETE FROM feeds WHERE id = ?").run(feedId);
  db().prepare("DELETE FROM inbox_bundles").run();
}

section("Importance: four stages, rated once, sorted most important first");
{
  const B = await import("../lib/inbox-bundles.ts");
  const I = await import("../lib/importance.ts");
  const members = new Map([["S7", [1, 2]], ["I3", [3]], ["I4", [4]], ["I5", [5]]]);
  const r = B.ratingsFromModel(members, {
    breaking: ["S7"],
    high: ["I3", " I999 "],
    medium: ["I3", "I4"],
    evergreen: [],
  });
  check("a story's accounts all get its stage", r.get(1) === "breaking" && r.get(2) === "breaking", JSON.stringify([...r]));
  check("an id named twice keeps the more important stage", r.get(3) === "high");
  check("unknown ids are dropped and what the model left out stays unrated", r.size === 4 && !r.has(5), JSON.stringify([...r]));
  check("a missing list is no answer, not a crash", B.ratingsFromModel(members, {}).size === 0);

  const now = Date.parse("2026-10-11T12:00:00Z");
  check("breaking stays breaking for a day", I.effectiveImportance("breaking", "2026-10-11T02:00:00Z", now) === "breaking");
  check("and is high after that", I.effectiveImportance("breaking", "2026-10-09T12:00:00Z", now) === "high");
  check("other stages do not fade", I.effectiveImportance("evergreen", "2020-01-01T00:00:00Z", now) === "evergreen");
  check("an unknown stage is unrated", I.effectiveImportance("urgent", null, now) === null);
  const order = ["evergreen", null, "medium", "high", "breaking"].sort((a, b) => I.importanceRank(a) - I.importanceRank(b));
  check("breaking, high, medium, unrated, evergreen", JSON.stringify(order) === JSON.stringify(["breaking", "high", "medium", null, "evergreen"]), JSON.stringify(order));
  check("a topic is placed by its most important article", I.topicScore([2, 0, 4]) < I.topicScore([1, 1, 1, 1]));
  check("and among equals, the one with more of them goes first", I.topicScore([0, 0, 2]) < I.topicScore([0, 2, 2]));
  check("an empty topic goes last", I.topicScore([]) > I.topicScore([4]));
  const rated = await B.rateInbox({ timeoutMs: 5000 });
  check("an empty inbox never reaches the model for rating", rated.asked === 0 && rated.model === null && rated.error === null, JSON.stringify(rated));
}

section("Applying the groups keeps your decisions and is idempotent");
{
  const mk = (title, outlet, at) =>
    Number(db().prepare("INSERT INTO sources (title, kind, status, outlet, published_at) VALUES (?, 'url', 'chunked', ?, ?)").run(title, outlet, at).lastInsertRowid);
  const story = (title, namedBy = "auto") => Number(db().prepare("INSERT INTO stories (title, shingle, named_by) VALUES (?, ?, ?)").run(title, title.toLowerCase(), namedBy).lastInsertRowid);
  const join = (s, src) => db().prepare("INSERT INTO story_sources (story_id, source_id) VALUES (?, ?)").run(s, src);
  const storyOf = (src) => db().prepare("SELECT story_id FROM story_sources WHERE source_id=?").get(src)?.story_id ?? null;
  const at = "2026-09-15T10:00:00.000Z";
  const s1 = mk("A", "X", at), s2 = mk("B", "Y", at), s3 = mk("C", "Z", at), s4 = mk("D", "W", at), s5 = mk("E", "V", at);
  const mine = story("My story", "user");
  const theirs = story("Auto story");
  const other = story("Another auto");
  join(mine, s1);
  join(theirs, s2);
  join(other, s4);
  const acc = (sourceId, storyId, namedBy) => ({ sourceId, storyId, namedBy, title: "t", outlet: "o", at, lede: "", summary: "" });
  const accounts = [acc(s1, mine, "user"), acc(s2, theirs, "auto"), acc(s3, null, null), acc(s4, other, "auto"), acc(s5, null, null)];
  const pair = (a, b) => ({ a, b, why: "tokens", score: 1, shared: ["x", "y"] });
  const r = G.applyGroups(accounts, [pair(s1, s2), pair(s2, s3), pair(s4, s5)]);
  check("accounts joined the story you named rather than the other way round", storyOf(s2) === mine && storyOf(s3) === mine, JSON.stringify([storyOf(s2), storyOf(s3), mine]));
  check("the auto story they left is gone", !db().prepare("SELECT 1 FROM stories WHERE id=?").get(theirs));
  check("an unfiled account joins the existing auto story", storyOf(s5) === other);
  check("the result counts what moved", r.grouped === 3 && r.stories === 2 && r.folded === 1, JSON.stringify(r));
  const again = G.applyGroups(
    accounts.map((a) => ({ ...a, storyId: storyOf(a.sourceId), namedBy: a.sourceId === s1 ? "user" : a.storyId === null ? null : "auto" })),
    [pair(s1, s2), pair(s2, s3), pair(s4, s5)]
  );
  check("a second pass does nothing", again.grouped === 0 && again.folded === 0, JSON.stringify(again));

  // Two stories you named are never merged, even through a chain.
  const s6 = mk("F", "U", at), s7 = mk("G", "T", at);
  const yours2 = story("Your other story", "user");
  join(yours2, s6);
  const r2 = G.applyGroups(
    [acc(s1, mine, "user"), acc(s6, yours2, "user"), acc(s7, null, null)],
    [pair(s1, s6), pair(s6, s7)]
  );
  check("two named stories stay two", storyOf(s1) === mine && storyOf(s6) === yours2, JSON.stringify(r2));
  check("and the loose account joined one of them, not a third", storyOf(s7) === yours2 || storyOf(s7) === mine, String(storyOf(s7)));
  check("regroupHeld on an empty inbox is a no-op", (await G.regroupHeld()).grouped === 0);
}

section("Grouping does not chain (17 Nov 2026: one story had 659 accounts)");
{
  const mk = (title, at) =>
    Number(db().prepare("INSERT INTO sources (title, kind, status, outlet, published_at) VALUES (?, 'url', 'chunked', 'O', ?)").run(title, at).lastInsertRowid);
  const storyOf = (src) => db().prepare("SELECT story_id FROM story_sources WHERE source_id=?").get(src)?.story_id ?? null;
  const hour = (h) => new Date(Date.UTC(2026, 10, 10, 8 + h)).toISOString();
  const lone = (title, h) => ({ sourceId: mk(title, hour(h)), storyId: null, namedBy: null, title, outlet: "O", at: hour(h), lede: "", summary: "" });
  const pair = (a, b, why = "tokens") => ({ a: Math.min(a.sourceId, b.sourceId), b: Math.max(a.sourceId, b.sourceId), why, score: 1, shared: ["x", "y"] });

  // A chain: each account like the next, the ends like nothing.
  const chain = Array.from({ length: 6 }, (_, i) => lone(`Chain ${i}`, i));
  G.applyGroups(chain, chain.slice(1).map((b, i) => pair(chain[i], b)));
  const ids = chain.map((a) => storyOf(a.sourceId));
  check("the two ends of a chain are not one story", ids[0] === null || ids[0] !== ids[5], JSON.stringify(ids));
  const biggest = Math.max(...Object.values(ids.reduce((n, id) => (id === null ? n : { ...n, [id]: (n[id] ?? 0) + 1 }), {})));
  check("and no story along it takes more than three links", biggest <= 3, JSON.stringify(ids));

  // A real event: every account like every other.
  const event = Array.from({ length: 5 }, (_, i) => lone(`Event ${i}`, i));
  const all = [];
  for (let i = 0; i < event.length; i++) for (let j = i + 1; j < event.length; j++) all.push(pair(event[i], event[j], "title"));
  G.applyGroups(event, all);
  check("accounts that all agree are one story", new Set(event.map((a) => storyOf(a.sourceId))).size === 1 && storyOf(event[0].sourceId) !== null);

  // An outsider that agrees with one account of that event does not join it.
  const outsider = lone("Outsider", 2);
  const withOut = event.map((a) => ({ ...a, storyId: storyOf(a.sourceId), namedBy: "auto" }));
  G.applyGroups([...withOut, outsider], [pair(event[4], outsider)]);
  check("one shared link is not enough to join a formed story", storyOf(outsider.sourceId) !== storyOf(event[0].sourceId));

  // Too far apart.
  const early = lone("Early", 0), late = lone("Late", 100);
  G.applyGroups([early, late], [pair(early, late, "title")]);
  check("accounts four days apart are not one event", storyOf(early.sourceId) === null || storyOf(early.sourceId) !== storyOf(late.sourceId));

  // Two formed stories are never folded by the inbox pass.
  const a1 = lone("A1", 0), a2 = lone("A2", 1), b1 = lone("B1", 0), b2 = lone("B2", 1);
  G.applyGroups([a1, a2, b1, b2], [pair(a1, a2, "title"), pair(b1, b2, "title")]);
  const formed = [a1, a2, b1, b2].map((a) => ({ ...a, storyId: storyOf(a.sourceId), namedBy: "auto" }));
  const before = formed.map((a) => a.storyId);
  const r = G.applyGroups(formed, [pair(a1, b1, "title"), pair(a1, b2, "title"), pair(a2, b1, "title"), pair(a2, b2, "title")]);
  check("two formed stories stay two, however alike", before[0] !== before[2] && storyOf(a1.sourceId) === before[0] && storyOf(b1.sourceId) === before[2] && r.folded === 0, JSON.stringify(r));

  // The model's groups are cliques; a story line vouches for the whole story.
  const at = (h) => new Date(Date.UTC(2026, 8, 15, 10 + h)).toISOString();
  const acc = (sourceId, storyId, title, h) => ({ sourceId, storyId, namedBy: storyId ? "auto" : null, title, outlet: "O", at: at(h), lede: "", summary: "" });
  const accounts = [acc(1, 50, "S a", 0), acc(2, 50, "S b", 1), acc(3, null, "x", 2), acc(4, null, "y", 2), acc(5, null, "z", 3)];
  const { storyRep } = G.headlineLines(accounts);
  const m = G.pairsFromModel(accounts, storyRep, [{ ids: ["I3", "I4", "I5"] }, { ids: ["S50", "I3"] }]);
  check("a model group of three is three pairs", m.pairs.filter((p) => !p.whole).length === 3, JSON.stringify(m.pairs));
  check("a pair with a story's line is marked as vouching for the story", m.pairs.some((p) => p.whole && p.a === 1 && p.b === 3));
}

section("Accounts that drifted into a story by a chain are taken out");
{
  const at = (h) => new Date(Date.UTC(2026, 10, 14, 8 + h)).toISOString();
  const mk = (title, h) => Number(db().prepare("INSERT INTO sources (title, kind, status, outlet, published_at) VALUES (?, 'url', 'chunked', 'O', ?)").run(title, at(h)).lastInsertRowid);
  const story = Number(db().prepare("INSERT INTO stories (title, shingle) VALUES ('Nvidia chief faces affair probe in Congress', 'x')").run().lastInsertRowid);
  const titles = [
    ["Nvidia chief faces affair probe in Congress", 0, "First account."],
    ["Congress widens Nvidia chief affair probe", 1, "Grouped in the inbox: shares x."],
    ["Huang ally speaks out", 2, "Grouped in the inbox: shares x."],
    ["October inflation data surprises markets", 3, "Grouped in the inbox: shares x."],
    ["Lawmakers to question chip boss", 4, "Grouped in the inbox by the model, checked against the story — probe."],
  ];
  const accs = titles.map(([title, h, reason]) => {
    const id = mk(title, h);
    db().prepare("INSERT INTO story_sources (story_id, source_id, reason) VALUES (?, ?, ?)").run(story, id, reason);
    return { sourceId: id, storyId: story, namedBy: "auto", title, outlet: "O", at: at(h), lede: "", summary: "" };
  });
  const pair = (x, y) => ({ a: Math.min(accs[x].sourceId, accs[y].sourceId), b: Math.max(accs[x].sourceId, accs[y].sourceId), why: "tokens", score: 1, shared: ["x", "y"] });
  // 2 is one step from a headline match; 3 is only reached through 2.
  const after = G.trimStrays(accs, [pair(1, 2), pair(2, 3)]);
  const storyOf = (src) => db().prepare("SELECT story_id FROM story_sources WHERE source_id=?").get(src)?.story_id;
  check("the opener and a headline match stay", storyOf(accs[0].sourceId) === story && storyOf(accs[1].sourceId) === story);
  check("an account one step from the headline stays", storyOf(accs[2].sourceId) === story);
  check("an account two steps away is taken out", storyOf(accs[3].sourceId) !== story && after[3].storyId !== story);
  check("one the model placed under the core rule stays", storyOf(accs[4].sourceId) === story);
  check("and a second pass takes nothing more", G.trimStrays(after, [pair(1, 2)]).every((a, i) => a.storyId === after[i].storyId));
}

section("Runaway stories are taken apart");
{
  const S = await import("../lib/stories.ts");
  const at = new Date(Date.UTC(2026, 10, 12, 9)).toISOString();
  const big = Number(db().prepare("INSERT INTO stories (title, shingle) VALUES ('Runaway', 'runaway')").run().lastInsertRowid);
  for (let i = 0; i <= S.MAX_STORY_ACCOUNTS; i++) {
    const src = Number(db().prepare("INSERT INTO sources (title, kind, status, outlet, published_at) VALUES (?, 'url', 'chunked', 'O', ?)").run(`Unrelated headline number ${i} about subject ${i * 7}`, at).lastInsertRowid);
    db().prepare("INSERT INTO story_sources (story_id, source_id) VALUES (?, ?)").run(big, src);
  }
  const split = S.splitRunaways();
  check("a story past the ceiling is taken apart", split.stories >= 1 && !db().prepare("SELECT 1 FROM stories WHERE id=?").get(big), JSON.stringify(split));
  const max = db().prepare("SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM story_sources GROUP BY story_id)").get().n;
  check("and no story is past it afterwards", max <= S.MAX_STORY_ACCOUNTS, String(max));
  check("a second pass has nothing to do", S.splitRunaways().stories === 0);
}

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
