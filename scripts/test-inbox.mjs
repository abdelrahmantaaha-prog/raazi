/**
 * The inbox's newer half: pictures, the preview pane's verdict, and articles
 * clipped from the browser.
 *
 * The properties: a feed's picture is found wherever the publisher put it and
 * never invented; the pane's verdict is the keep rule and nothing softer; and
 * a clip is an ordinary held item — grouped, undoable, recognised by address
 * — whose text replaces a stub rather than sitting beside it.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-inbox.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_inbox__");
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
const feeds = await import("../lib/feeds.ts");
const triage = await import("../lib/triage.ts");
const clip = await import("../lib/clip.ts");
const { JSDOM } = await import("jsdom");
const { readMeta } = await import("../lib/ingest/web.ts");

section("A feed's picture is found where the publisher put it");
{
  const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>Wire</title>
<item><guid>a</guid><title>Media content</title><link>https://example.com/a</link>
  <media:content url="https://cdn.example.com/a.jpg" medium="image" width="1200"/></item>
<item><guid>b</guid><title>Thumbnail</title><link>https://example.com/b</link>
  <media:thumbnail url="/thumbs/b.png"/></item>
<item><guid>c</guid><title>Enclosure</title><link>https://example.com/c</link>
  <enclosure url="https://cdn.example.com/c.jpg" type="image/jpeg" length="1"/></item>
<item><guid>d</guid><title>Inline</title><link>https://example.com/d</link>
  <description><![CDATA[<p>Text</p><img src="https://cdn.example.com/d.jpg" width="640">]]></description></item>
<item><guid>e</guid><title>Tracker only</title><link>https://example.com/e</link>
  <description><![CDATA[<img src="https://px.example.com/p.gif" width="1" height="1"> words]]></description></item>
<item><guid>f</guid><title>Video is not a picture</title><link>https://example.com/f</link>
  <media:content url="https://cdn.example.com/f.mp4" medium="video"/></item>
<item><guid>g</guid><title>Nothing</title><link>https://example.com/g</link></item>
</channel></rss>`;
  const parsed = feeds.parseFeed(rss);
  const by = Object.fromEntries(parsed.items.map((i) => [i.guid, i.image ?? null]));
  check("media:content image", by.a === "https://cdn.example.com/a.jpg", String(by.a));
  check("media:thumbnail, resolved against the link", by.b === "https://example.com/thumbs/b.png", String(by.b));
  check("image enclosure", by.c === "https://cdn.example.com/c.jpg", String(by.c));
  check("first <img> in the description", by.d === "https://cdn.example.com/d.jpg", String(by.d));
  check("a one-pixel tracker is not a picture", by.e === null, String(by.e));
  check("a video enclosure is not a picture", by.f === null, String(by.f));
  check("no picture is null", by.g === null, String(by.g));

  const feedId = Number(
    db().prepare("INSERT INTO feeds (url, title, outlet) VALUES ('https://w.example/rss', 'Wire', 'Wire')").run().lastInsertRowid
  );
  feeds.recordItems(feedId, parsed.items, null);
  const stored = db().prepare("SELECT guid, image_url FROM feed_items WHERE feed_id=? ORDER BY guid").all(feedId);
  check("the picture is recorded on the item", stored.find((r) => r.guid === "a")?.image_url === "https://cdn.example.com/a.jpg");
}

section("A page's own picture is read from its meta tags");
{
  const html = `<html><head><meta property="og:image" content="/pics/lead.jpg"><meta property="og:title" content="T"></head><body></body></html>`;
  const doc = new JSDOM(html, { url: "https://outlet.example/story" }).window.document;
  const meta = readMeta(doc, "https://outlet.example/story");
  check("og:image, made absolute", meta.image === "https://outlet.example/pics/lead.jpg", String(meta.image));
  const none = readMeta(new JSDOM("<html><head></head></html>", { url: "https://x.example/" }).window.document, "https://x.example/");
  check("no tag, no picture", none.image === undefined);
}

section("The pane's verdict is the keep rule");
{
  const feedId = Number(
    db().prepare("INSERT INTO feeds (url, title, outlet) VALUES ('https://p.example/rss', 'Paper', 'Paper')").run().lastInsertRowid
  );
  const mk = (title, text, note = null) => {
    const sourceId = Number(
      db()
        .prepare("INSERT INTO sources (title, kind, url, status, triage, note) VALUES (?, 'url', ?, 'chunked', 'held', ?)")
        .run(title, `https://p.example/${title}`, note).lastInsertRowid
    );
    db().prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, ?, '{}')").run(sourceId, text);
    return Number(
      db()
        .prepare("INSERT INTO feed_items (feed_id, guid, url, title, state, source_id) VALUES (?, ?, ?, ?, 'held', ?)")
        .run(feedId, title, `https://p.example/${title}`, title, sourceId).lastInsertRowid
    );
  };
  const full = mk("full", "Officials met for three hours. ".repeat(60));
  const stub = mk("stub", "Subscribe to read this article.");
  const summary = mk(
    "summary",
    "The feed summary, which happens to be long. ".repeat(40),
    "The page could not be read (Fetch failed: 403); this is the summary the feed carried."
  );
  check("a real article is enough", triage.heldText(full)?.verdict === "enough");
  check("word and passage counts come with it", triage.heldText(full)?.words > 100 && triage.heldText(full)?.passages.length === 1);
  check("a stub is thin", triage.heldText(stub)?.verdict === "thin");
  check("a long feed summary is still only a summary", triage.heldText(summary)?.verdict === "summary");
  check("an item that is not held is null", triage.heldText(999999) === null);
  check("listHeld carries the picture and the source note", (() => {
    const rows = triage.listHeld();
    const s = rows.find((r) => r.id === summary);
    return s && "image" in s && /could not be read/.test(s.source_note ?? "");
  })());
}

section("A clip from the browser is an ordinary held item with the full text");
{
  const article = "The committee met on Tuesday and heard three witnesses. ".repeat(40);
  const first = clip.clipArticle({
    url: "https://paper.example/politics/story?utm_source=x",
    title: "Committee hears witnesses",
    text: article,
    author: "A. Reporter",
    publishedAt: "2026-09-10T08:00:00Z",
    outlet: "The Paper",
    image: "https://paper.example/lead.jpg",
    lang: "en",
  });
  check("creates an item and a source", first.itemId > 0 && first.sourceId > 0 && !first.replaced);
  const item = db().prepare("SELECT * FROM feed_items WHERE id=?").get(first.itemId);
  check("the item is held under the clip feed", item.state === "held" && item.feed_id === clip.clipFeedId());
  check("the clip feed is disabled so it is never polled", db().prepare("SELECT enabled FROM feeds WHERE id=?").get(item.feed_id).enabled === 0);
  check("the tracking parameter is gone from the canonical address", item.canonical_url === "https://paper.example/politics/story");
  check("the picture is on the item", item.image_url === "https://paper.example/lead.jpg");
  const source = db().prepare("SELECT * FROM sources WHERE id=?").get(first.sourceId);
  check("the source is held, with outlet, author and date", source.triage === "held" && source.outlet === "The Paper" && source.author === "A. Reporter" && source.published_at?.startsWith("2026-09-10"));
  check("the pane says it is enough", triage.heldText(first.itemId)?.verdict === "enough");
  check("it shows in the inbox marked as full text", triage.listHeld().some((r) => r.id === first.itemId && r.note === "Full text clipped from the browser."));

  const again = clip.clipArticle({ url: "https://paper.example/politics/story", title: "Committee hears witnesses", text: `${article} And a fourth.` });
  check("the same address again replaces the text rather than doubling", again.replaced && again.itemId === first.itemId && again.sourceId === first.sourceId);
  check("only one item exists for the address", db().prepare("SELECT COUNT(*) AS n FROM feed_items WHERE canonical_url=?").get("https://paper.example/politics/story").n === 1);

  triage.discard([first.itemId]);
  const third = clip.clipArticle({ url: "https://paper.example/politics/story", title: "Committee hears witnesses", text: article });
  check("clipping a discarded address puts it back in the inbox", third.replaced && db().prepare("SELECT state FROM feed_items WHERE id=?").get(first.itemId).state === "held");

  triage.keep([first.itemId]);
  let refused = null;
  try {
    clip.clipArticle({ url: "https://paper.example/politics/story", title: "x", text: article });
  } catch (err) {
    refused = err;
  }
  check("an article already read is refused, naming the source", refused instanceof clip.AlreadyReadError && refused.sourceId === first.sourceId);

  let short = null;
  try {
    clip.clipArticle({ url: "https://paper.example/other", title: "x", text: "Too short." });
  } catch (err) {
    short = err;
  }
  check("too little text is refused", short !== null && /characters/.test(short.message));
  let bad = null;
  try {
    clip.clipArticle({ url: "ftp://nope", title: "x", text: article });
  } catch (err) {
    bad = err;
  }
  check("a non-web address is refused", bad !== null);
}

section("What you push from the browser heads the inbox, and the inbox can tell it arrived");
{
  const body = "The minister answered questions for an hour. ".repeat(40);
  const pause = () => new Promise((r) => setTimeout(r, 5));
  const feedId = Number(
    db().prepare("INSERT INTO feeds (url, title, outlet) VALUES ('https://order.example/rss', 'Order', 'Order')").run().lastInsertRowid
  );

  const before = triage.clipStamp();
  // The newest thing a feed could bring: dated years ahead of anything clipped.
  const sourceId = Number(
    db().prepare("INSERT INTO sources (title, kind, url, status, triage) VALUES ('fresh', 'url', 'https://order.example/fresh', 'chunked', 'held')").run().lastInsertRowid
  );
  db().prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, ?, '{}')").run(sourceId, body);
  const fromFeed = Number(
    db()
      .prepare("INSERT INTO feed_items (feed_id, guid, url, title, state, source_id, published_at) VALUES (?, 'fresh', 'https://order.example/fresh', 'fresh', 'held', ?, '2099-01-01T00:00:00Z')")
      .run(feedId, sourceId).lastInsertRowid
  );
  check("a feed bringing something in does not move the stamp", triage.clipStamp() === before);
  check("unclipped items carry no clip time", triage.listHeld().find((r) => r.id === fromFeed)?.clipped_at === null);

  await pause();
  const older = clip.clipArticle({ url: "https://order.example/older", title: "Older", text: body, publishedAt: "2020-01-01T00:00:00Z" });
  const afterOne = triage.clipStamp();
  check("a clip moves the stamp", afterOne !== before, `${before} → ${afterOne}`);
  check("and heads the list, however old the article", triage.listHeld()[0].id === older.itemId);
  check("the clip time is kept to the millisecond", /\.\d{3}$/.test(db().prepare("SELECT clipped_at FROM feed_items WHERE id=?").get(older.itemId).clipped_at ?? ""));

  await pause();
  const newer = clip.clipArticle({ url: "https://order.example/newer", title: "Newer", text: body });
  const order = triage.listHeld().map((r) => r.id);
  check("the latest clip comes first", order[0] === newer.itemId && order[1] === older.itemId, JSON.stringify(order.slice(0, 3)));
  check("and everything a feed brought comes after the clips", order.indexOf(fromFeed) > order.indexOf(older.itemId));

  await pause();
  const stampBeforeReplace = triage.clipStamp();
  const replaced = clip.clipArticle({ url: "https://order.example/older", title: "Older", text: `${body} With a correction.` });
  check("sending full text to an item already waiting replaces it in place", replaced.replaced && replaced.itemId === older.itemId);
  check("which moves the stamp, so an open inbox refreshes", triage.clipStamp() !== stampBeforeReplace);
  check("and brings that item back to the top", triage.listHeld()[0].id === older.itemId);
}

section("The extension sends an article with its paragraphs apart");
{
  // The real extension scripts, run in a page: Readability, then content.js.
  const readability = fs.readFileSync(path.join(root, "extension", "readability.js"), "utf8");
  const content = fs.readFileSync(path.join(root, "extension", "content.js"), "utf8");
  const para = (n) =>
    `<p>Paragraph ${n} opens here. The committee heard from officials about the budget, the schedule and what the agency still has not explained to members.</p>`;
  // No whitespace between the tags, which is how most publishers' HTML arrives
  // and exactly what textContent runs together.
  const html =
    `<!doctype html><html lang="en"><head><title>Budget hearing</title>` +
    `<meta property="og:site_name" content="The Paper"></head><body>` +
    `<nav><a href="/">Home</a><a href="/politics">Politics</a></nav>` +
    `<main><article><h1>Budget hearing</h1>${para(1)}${para(2)}` +
    `<figure><img src="x.jpg"><figcaption>A caption that is not the article.</figcaption></figure>` +
    `<h2>What comes next</h2>${para(3)}<ul><li>First step</li><li>Second step</li></ul>${para(4)}${para(5)}${para(6)}${para(7)}` +
    `<p>A line<br>broken by hand.</p></article></main></body></html>`;
  const dom = new JSDOM(html, { url: "https://paper.example/budget", runScripts: "outside-only" });
  dom.window.eval(readability);
  const sent = dom.window.eval(content);

  check("paragraphs are separated by a blank line", /explained to members\.\n\nParagraph 2 opens/.test(sent.text), JSON.stringify(sent.text.slice(0, 220)));
  check("no two paragraphs are run together", !/members\.Paragraph/.test(sent.text));
  check("a subheading is marked so Raazi can label what follows", /\n\n## What comes next\n\n/.test(sent.text));
  check("list items stay on lines of their own", /- First step\n\n- Second step/.test(sent.text), JSON.stringify(sent.text.match(/- First[\s\S]{0,30}/)?.[0]));
  check("a line break inside a paragraph survives", /A line\nbroken by hand\./.test(sent.text));
  check("the figure caption is left out", !sent.text.includes("A caption"));

  const clipped = clip.clipArticle({ url: sent.url, title: sent.title, text: sent.text, outlet: sent.outlet });
  const passages = triage.heldText(clipped.itemId)?.passages.map((p) => p.text).join("\n\n") ?? "";
  check("and Raazi keeps them apart in what the pane shows", /members\.\n\nParagraph 2 opens/.test(passages), JSON.stringify(passages.slice(0, 160)));
}

section("The inbox can be searched, headline, outlet and text");
{
  // The telling words sit past the first paragraph, so the summary a clip
  // stores does not carry them and only the article text can.
  const filler = "Background on the week in Parliament and Congress. ".repeat(12);
  const sanctions = clip.clipArticle({
    url: "https://search.example/a",
    title: "Treasury widens sanctions",
    text: `${filler}${"Officials in Tehran responded to the new measures. ".repeat(20)}`,
    outlet: "Search Wire",
  });
  const pipeline = clip.clipArticle({
    url: "https://search.example/b",
    title: "A quiet morning",
    text: `${filler}${"The committee discussed pipeline permits in Alberta. ".repeat(20)}`,
    outlet: "Northern Post",
  });
  const ids = (q) => triage.listHeld(200, q).map((r) => r.id);

  check("with no query, everything waiting", ids("").includes(sanctions.itemId) && ids("").includes(pipeline.itemId));
  check("a word in the headline finds it, and only it", ids("sanctions").includes(sanctions.itemId) && !ids("sanctions").includes(pipeline.itemId));
  check("case does not matter", ids("TREASURY").includes(sanctions.itemId));
  check("the outlet finds it", ids("Northern Post").includes(pipeline.itemId) && !ids("Northern Post").includes(sanctions.itemId));
  check(
    "a word only in the article text finds it",
    ids("Alberta").includes(pipeline.itemId) && !ids("Alberta").includes(sanctions.itemId),
    JSON.stringify(ids("Alberta"))
  );
  check("the word is not in the stored summary, so the text is what matched", !/Alberta/.test(triage.listHeld(200, "Alberta").find((r) => r.id === pipeline.itemId)?.summary ?? ""));
  check("the last word matches as a prefix, while it is being typed", ids("pipel").includes(pipeline.itemId));
  check("several words must all be there", ids("committee Alberta").includes(pipeline.itemId) && !ids("committee Tehran").includes(pipeline.itemId));
  check("a headline word and a text word together are not enough apart", !ids("quiet Tehran").includes(pipeline.itemId));
  check("nothing matching is nothing", ids("zzqqxx").length === 0);
  check(
    "quotes, stars, brackets and operators do not break it",
    [`"`, "*", "(", "Tehran)", "OR", "NEAR(", "a:b", `"Tehran`].every((q) => Array.isArray(triage.listHeld(200, q)))
  );
  check("a percent sign is a character, not a wildcard", ids("%").length === 0);
  check("the safe query quotes every word and makes the last a prefix", triage.inboxMatch(["Iran", "sanc"]) === `"Iran" "sanc"*`);
  check("words with nothing to index are left out of it", triage.inboxMatch(["*", "(", "%"]) === null);

  triage.discard([pipeline.itemId]);
  check("what has been decided is not found", !ids("Alberta").includes(pipeline.itemId));
}

section("Quotes marked on a page are gathered to a draft, tied to the article");
{
  const drafts = await import("../lib/drafts.ts");
  const draftId = drafts.createDraft("Budget piece");
  const text = `${"Background on the week in Congress. ".repeat(10)}The subcommittee cut the disaster relief line by a third. ${"Members argued about the schedule. ".repeat(20)}`;
  const c = clip.clipArticle({ url: "https://gather.example/budget", title: "Budget cuts", text, author: "A. Writer", outlet: "Gather Post" });

  const r = clip.gatherQuotes(draftId, c.sourceId, [
    "The subcommittee cut   the disaster\nrelief line by a third.",
    "Words that are not in the article at all, typed by hand.",
  ]);
  const notes = drafts.notesFor(draftId);
  check("both quotes go onto the draft", r.gathered === 2 && notes.length === 2 && r.draftTitle === "Budget piece");
  const found = notes.find((n) => n.text.startsWith("The subcommittee"));
  check("a quote found in the article is tied to its source and its passage", found?.source_id === c.sourceId && found?.chunk_id !== null);
  check("stored as the article has it, not as the selection spaced it", found?.text === "The subcommittee cut the disaster relief line by a third.", JSON.stringify(found?.text));
  check("with a citation to the article", /Budget cuts/.test(found?.citation ?? ""), found?.citation);
  const typed = notes.find((n) => n.text.startsWith("Words"));
  check("a quote the article does not hold is still kept, tied to the source but no passage", typed?.source_id === c.sourceId && typed?.chunk_id === null);

  const again = clip.gatherQuotes(draftId, c.sourceId, ["The subcommittee cut the disaster relief line by a third."]);
  check("the same words twice are kept once", again.gathered === 0 && again.skipped === 1 && drafts.notesFor(draftId).length === 2);
  check("the article went to the inbox with them", triage.listHeld().some((i) => i.id === c.itemId));

  let gone = null;
  try {
    clip.gatherQuotes(999999, c.sourceId, ["The subcommittee cut the disaster relief line by a third."]);
  } catch (err) {
    gone = err;
  }
  check("a draft that is gone is refused, saying so", gone instanceof clip.GatherError);
  check("a page already sent is found again by its address, for the next quote", clip.sourceForUrl("https://gather.example/budget?utm_source=x") === c.sourceId);
  check("an address never sent is not", clip.sourceForUrl("https://gather.example/other") === null);
}

section("A star keeps an article for a closer look, whatever you decide about it");
{
  const starred = await import("../lib/starred.ts");
  const body = "The senator laid out the bill clause by clause. ".repeat(40);
  const c = clip.clipArticle({
    url: "https://star.example/bill",
    title: "The bill",
    text: body,
    outlet: "Star Paper",
    image: "https://star.example/p.jpg",
  });

  check("nothing is starred to begin with", !starred.listStarred().some((a) => a.id === c.sourceId));
  check("the inbox says the item is not starred", triage.listHeld().find((r) => r.id === c.itemId)?.starred === 0);
  check("starring an article that exists succeeds", starred.setStarred(c.sourceId, true) === true);
  check("and one that does not is refused", starred.setStarred(999999, true) === false);

  const a = starred.listStarred().find((x) => x.id === c.sourceId);
  check(
    "it is listed with its outlet, picture and opening",
    a && a.outlet === "Star Paper" && a.image === "https://star.example/p.jpg" && a.lede?.startsWith("The senator"),
    JSON.stringify(a && { outlet: a.outlet, image: a.image, lede: a.lede?.slice(0, 20) })
  );
  check(
    "with its words counted and the inbox item it came from",
    a && a.words >= 300 && a.item_id === c.itemId && a.item_state === "held",
    JSON.stringify(a && { words: a.words, item: a.item_id, state: a.item_state })
  );
  check("the inbox marks it starred and still holds it", triage.listHeld().find((r) => r.id === c.itemId)?.starred === 1);

  const firstStarred = a?.starred_at;
  starred.setStarred(c.sourceId, true);
  check("starring it again keeps the time it was first starred", starred.listStarred().find((x) => x.id === c.sourceId)?.starred_at === firstStarred);

  triage.discard([c.itemId]);
  const after = starred.listStarred().find((x) => x.id === c.sourceId);
  check(
    "discarding it in the inbox does not unstar it, and its text is still there",
    after && after.item_state === "discarded" && after.chars > 1000,
    JSON.stringify(after && { state: after.item_state, chars: after.chars })
  );

  starred.setStarred(c.sourceId, false);
  check("unstarring takes it off the list", !starred.listStarred().some((x) => x.id === c.sourceId));
}

console.log(`\n${passed} passed, ${failed} failed`);
db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
