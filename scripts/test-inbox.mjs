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

console.log(`\n${passed} passed, ${failed} failed`);
db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
