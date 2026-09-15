/**
 * The aggregator: feeds, items, stories, the watchlist, and the brief's
 * material.
 *
 * The properties worth protecting are the ones that make a beat readable
 * rather than merely full: the same story from six outlets is one story; an
 * item already in the library is never fetched twice; a feed added today does
 * not drag in its archive; and the brief is built from rows, so nothing can
 * appear in it that is not in the database.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-feeds.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_feeds__");
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
const stories = await import("../lib/stories.ts");
const watchlist = await import("../lib/watchlist.ts");
const brief = await import("../lib/brief.ts");

/* ------------------------------------------------------------- parsing */

section("Reading what a feed actually sends");
{
  const rss = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>The Globe and Mail — Politics</title>
      <item>
        <title>Ottawa and Washington resume tariff talks</title>
        <link>https://example.com/a?utm_source=rss&amp;utm_medium=feed</link>
        <guid isPermaLink="false">globe-9931</guid>
        <pubDate>Wed, 04 Mar 2026 14:00:00 GMT</pubDate>
        <description>Officials said the round would be short.</description>
      </item>
      <item>
        <title>Second story</title>
        <link>https://example.com/b</link>
        <pubDate>Wed, 04 Mar 2026 09:30:00 GMT</pubDate>
      </item>
    </channel></rss>`;

  const parsed = feeds.parseFeed(rss);
  check("an RSS channel is recognised", parsed.kind === "rss" && parsed.title.startsWith("The Globe"));
  check("both items are read", parsed.items.length === 2);
  check("the stable id wins over the link", parsed.items[0].guid === "globe-9931");
  check("an item with no guid falls back to its link", parsed.items[1].guid === "https://example.com/b");
  check(
    "the date becomes an ISO timestamp",
    parsed.items[0].publishedAt?.startsWith("2026-03-04T14:00"),
    parsed.items[0].publishedAt
  );
  check("the summary is kept", parsed.items[0].summary?.startsWith("Officials said"));

  const atom = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>CBC Politics</title>
      <entry>
        <title>Carney names a new trade envoy</title>
        <link rel="alternate" href="https://cbc.example/x"/>
        <link rel="edit" href="https://cbc.example/edit"/>
        <id>tag:cbc,2026:1234</id>
        <published>2026-03-04T11:15:00Z</published>
        <summary>The appointment was announced Wednesday.</summary>
      </entry>
    </feed>`;
  const a = feeds.parseFeed(atom);
  check("an Atom feed is recognised", a.kind === "atom" && a.items.length === 1);
  check("the alternate link is the one taken", a.items[0].url === "https://cbc.example/x");
  check("the Atom id is the guid", a.items[0].guid === "tag:cbc,2026:1234");

  let threw = false;
  try {
    feeds.parseFeed("<html><body>not a feed</body></html>");
  } catch {
    threw = true;
  }
  check("a page that is not a feed is refused", threw || feeds.parseFeed("<html></html>").items.length === 0);

  check(
    "a YouTube channel resolves to its feed",
    feeds.youtubeFeedUrl("https://www.youtube.com/channel/UC123abc") ===
      "https://www.youtube.com/feeds/videos.xml?channel_id=UC123abc"
  );
  check("a plain article URL is not a YouTube feed", feeds.youtubeFeedUrl("https://example.com/a") === null);
  check(
    "a phrase becomes a news query feed",
    feeds.newsQueryFeedUrl("softwood lumber").includes("q=softwood%20lumber")
  );
}

/* ------------------------------------------------------ a watched page */

section("A page with no feed is read as one");
// Modelled on shoman.org/الأخبار, a DNN page with no RSS: each article
// appears twice (its headline and a "المزيد" button), the navigation is
// full of short links, and every article shares "ArticleID/" in its address.
{
  const page = `<!doctype html><html><head><title>مؤسسة عبد الحميد شومان</title>
    <meta property="og:site_name" content="Shoman Foundation"></head><body>
    <header><a href="/">الرئيسية</a><a href="/الأخبار">الأخبار</a><a href="/about-us">About the foundation and its work</a></header>
    <nav><a href="/events">الفعاليات</a></nav>
    <main>
      <div class="item"><h3 class="title"><a href="https://shoman.org/الأخبار/ArticleID/4258/winners">"شومان" تعلن الفائزين بجائزة أدب الأطفال</a></h3>
        <a class="item-btn" href="https://shoman.org/الأخبار/ArticleID/4258/winners"> المزيد</a></div>
      <div class="item"><h3 class="title"><a href="/الأخبار/ArticleID/4255/researchers">"شومان" تعلن أسماء الفائزين بجائزتها للباحثين</a></h3>
        <a class="item-btn" href="/الأخبار/ArticleID/4255/researchers">المزيد</a></div>
      <a href="https://twitter.com/shoman">Follow us on Twitter for more news</a>
      <a href="/الأخبار#top">Top</a>
      <a href="/tags/cinema">Cinema</a>
    </main>
    <footer><a href="/privacy-policy-and-terms-of-use">Privacy policy and terms of use</a></footer>
  </body></html>`;

  const p = feeds.parsePage(page, "https://shoman.org/الأخبار");
  check("it is a page", p.kind === "page");
  check("named after the site", p.title === "Shoman Foundation", p.title);
  check("two articles, each folded from its headline and its button", p.items.length === 2, JSON.stringify(p.items.map((i) => i.title)));
  check("the headline is the title, not the button", p.items[0].title.startsWith('"شومان" تعلن الفائزين'), p.items[0].title);
  check("a relative address is made absolute", p.items[1].url === "https://shoman.org/%D8%A7%D9%84%D8%A3%D8%AE%D8%A8%D8%A7%D8%B1/ArticleID/4255/researchers", p.items[1].url);
  check("the id is the address", p.items[0].guid.includes("ArticleID/4258"));
  check("navigation, footer and other sites are left out", !p.items.some((i) => /about-us|privacy|twitter|events|tags/.test(i.url ?? "")));
  check("a page item has no date to be older than", p.items.every((i) => i.publishedAt === null));

  const narrowed = feeds.parsePage(page, "https://shoman.org/الأخبار", "ArticleID/");
  check("a pattern narrows to the links that carry it", narrowed.items.length === 2 && narrowed.items.every((i) => i.url?.includes("ArticleID/")));
  const rx = feeds.parsePage(page, "https://shoman.org/الأخبار", "/ArticleID\\/42\\d\\d/");
  check("or a regex", rx.items.length === 2);
  const none = feeds.parsePage(page, "https://shoman.org/الأخبار", "NewsID=");
  check("a pattern nothing matches finds nothing", none.items.length === 0);

  const advertised = `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body></body></html>`;
  check("a page that advertises a feed says where", feeds.discoverFeedUrl(advertised, "https://example.org/news") === "https://example.org/feed.xml");
  check("a page that does not, does not", feeds.discoverFeedUrl(page, "https://shoman.org/الأخبار") === null);
  check("a web page is told from a feed", feeds.looksLikeHtml(page) && !feeds.looksLikeHtml("<?xml version=\"1.0\"?><rss></rss>"));

  // Seeding: what the page holds when it is added is recorded as seen, not read.
  const feedId = Number(
    db().prepare("INSERT INTO feeds (url, title, kind) VALUES ('https://shoman.org/الأخبار', 'Shoman', 'page')").run().lastInsertRowid
  );
  const seeded = feeds.recordItems(feedId, p.items, null, { seed: true });
  check("seeding queues nothing", seeded.length === 0);
  const states = db().prepare("SELECT state, note FROM feed_items WHERE feed_id=?").all(feedId);
  check("but every link is on record as skipped", states.length === 2 && states.every((s) => s.state === "skipped" && /when it was added/.test(s.note)));
  // The next poll: the same two, plus one that was not there before.
  const later = feeds.parsePage(
    page.replace("</main>", `<div class="item"><h3 class="title"><a href="/الأخبار/ArticleID/4260/new-story">مقال جديد ظهر اليوم على الصفحة</a></h3></div></main>`),
    "https://shoman.org/الأخبار"
  );
  const fresh = feeds.recordItems(feedId, later.items, null);
  check("only the link that was not there last time is new", fresh.length === 1);
  check("and it is the new one", db().prepare("SELECT url FROM feed_items WHERE id=?").get(fresh[0]).url.includes("ArticleID/4260"));
}

/* --------------------------------------------------- redirect unwrapping */

section("A search feed links to itself; the article is in the query string");
{
  const { unwrapRedirect } = await import("../lib/ingest/meta.ts");
  check(
    "Bing's click wrapper gives up the real address",
    unwrapRedirect("http://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&url=https%3a%2f%2fwww.reuters.com%2fworld%2fx") ===
      "https://www.reuters.com/world/x"
  );
  check(
    "so does a Google redirect",
    unwrapRedirect("https://www.google.com/url?q=https://apnews.com/article/y&sa=t") === "https://apnews.com/article/y"
  );
  check(
    "an ordinary article link is left exactly as it is",
    unwrapRedirect("https://www.npr.org/2026/09/03/x") === "https://www.npr.org/2026/09/03/x"
  );
  check(
    "a Google News blob has no address to give, and is not mangled",
    unwrapRedirect("https://news.google.com/rss/articles/CBMimgFBVV95cUx?oc=5") ===
      "https://news.google.com/rss/articles/CBMimgFBVV95cUx?oc=5"
  );
  check(
    "a wrapper carrying something that is not a URL is left alone",
    unwrapRedirect("http://www.bing.com/news/apiclick.aspx?url=javascript:alert(1)").startsWith("http://www.bing.com")
  );
  check("junk in, junk out, no throw", unwrapRedirect("not a url") === "not a url");
}

/* ------------------------------------------------------- item recording */

section("What arrives twice is recorded once");
{
  const feedId = Number(
    db()
      .prepare("INSERT INTO feeds (url, title, outlet, since) VALUES ('https://f.example/rss','F','F Outlet',?)")
      .run("2026-03-01T00:00:00.000Z").lastInsertRowid
  );

  const items = [
    { guid: "g1", url: "https://example.com/a?utm_source=rss", title: "One", summary: null, publishedAt: "2026-03-04T14:00:00.000Z" },
    { guid: "g2", url: "https://example.com/b", title: "Two", summary: null, publishedAt: "2026-03-04T09:00:00.000Z" },
    { guid: "g3", url: "https://example.com/old", title: "Old", summary: null, publishedAt: "2026-02-01T09:00:00.000Z" },
  ];

  const fresh = feeds.recordItems(feedId, items, "2026-03-01T00:00:00.000Z");
  check("the two recent items are worth reading", fresh.length === 2, JSON.stringify(fresh));
  check(
    "an item older than the day the feed was added is recorded but not read",
    db().prepare("SELECT state FROM feed_items WHERE guid='g3'").get().state === "skipped"
  );
  check(
    "tracking parameters are stripped from the stored address",
    db().prepare("SELECT canonical_url FROM feed_items WHERE guid='g1'").get().canonical_url ===
      "https://example.com/a"
  );

  const again = feeds.recordItems(feedId, items, "2026-03-01T00:00:00.000Z");
  check("polling again offers nothing new", again.length === 0);

  // The same story under a different id, from a second feed.
  const feed2 = Number(
    db().prepare("INSERT INTO feeds (url, title) VALUES ('https://g.example/rss','G')").run().lastInsertRowid
  );
  const dup = feeds.recordItems(
    feed2,
    [{ guid: "other-id", url: "https://example.com/a", title: "One, syndicated", summary: null, publishedAt: "2026-03-04T15:00:00.000Z" }],
    null
  );
  check("the same address from another feed is not fetched twice", dup.length === 0);
  check(
    "and it says why",
    db().prepare("SELECT state FROM feed_items WHERE guid='other-id'").get().state === "duplicate"
  );

  db().prepare("UPDATE feed_items SET state='ready', queued_at=datetime('now') WHERE guid IN ('g1','g2')").run();
  check("the daily count sees them", feeds.ingestedToday(feedId) === 2);

  const due = feeds.dueFeeds();
  check("a feed never polled is due", due.some((f) => f.id === feedId));
  feeds.markPolled(feedId, "ok");
  check("and not due again immediately", !feeds.dueFeeds().some((f) => f.id === feedId));
}

/* -------------------------------------------------------------- stories */

section("Six outlets, one story");
{
  const mk = (title, at, outlet) =>
    Number(
      db()
        .prepare("INSERT INTO sources (title, kind, status, outlet, published_at) VALUES (?, 'url', 'ready', ?, ?)")
        .run(title, outlet, at).lastInsertRowid
    );

  check(
    "rewritten headlines about one event overlap",
    stories.titleSimilarity(
      "Ottawa and Washington resume tariff talks",
      "Canada, U.S. resume tariff talks in Washington"
    ) >= 0.42
  );
  check(
    "two different stories about one subject do not",
    stories.titleSimilarity(
      "Ottawa and Washington resume tariff talks",
      "Ottawa names new ambassador to Mexico"
    ) < 0.42
  );

  const a = mk("Ottawa and Washington resume tariff talks", "2026-03-04T14:00:00.000Z", "Globe");
  const b = mk("Canada and Washington resume tariff talks in Ottawa", "2026-03-04T15:00:00.000Z", "CBC");
  const far = mk("Ottawa and Washington resume tariff talks", "2026-04-20T15:00:00.000Z", "Star");

  const s1 = stories.fileSource(a);
  const s2 = stories.fileSource(b);
  check("the first account opens a story", s1.created === true);
  check("the second joins it", s2.created === false && s2.storyId === s1.storyId, JSON.stringify(s2));
  check("filing twice is idempotent", stories.fileSource(b).storyId === s1.storyId);

  const s3 = stories.fileSource(far);
  check("the same headline six weeks later is a different story", s3.storyId !== s1.storyId);

  const detail = stories.storyDetail(s1.storyId);
  check("the story lists both accounts", detail.accounts_list.length === 2);
  check("and names the outlets", detail.accounts_list.map((x) => x.outlet).sort().join() === "CBC,Globe");

  const split = stories.splitAccount(b);
  check("an account can be separated by hand", split.storyId !== s1.storyId);
  check(
    "and the story it left still holds the other",
    stories.storyDetail(s1.storyId).accounts_list.length === 1
  );

  stories.mergeStories(s1.storyId, split.storyId);
  check("stories can be merged back", stories.storyDetail(s1.storyId).accounts_list.length === 2);
  check("and the absorbed story is gone", stories.storyDetail(split.storyId) === undefined);

  stories.renameStory(s1.storyId, "Tariff talks, March 2026");
  const renamed = stories.listStories().find((x) => x.id === s1.storyId);
  check("renaming sticks and is marked as yours", renamed.title === "Tariff talks, March 2026" && renamed.named_by === "user");
}

/* ------------------------------------------------------------ watchlist */

section("What you are following");
{
  const entityId = Number(
    db()
      .prepare("INSERT INTO entities (type, canonical_name, normalized) VALUES ('person','Mark Carney','mark carney')")
      .run().lastInsertRowid
  );
  const tagId = Number(db().prepare("INSERT INTO tags (name) VALUES ('Trade')").run().lastInsertRowid);

  const w1 = watchlist.watch({ entityId });
  check("an entity can be watched", w1 > 0 && watchlist.isWatched(entityId));
  check("watching twice does not duplicate", watchlist.watch({ entityId }) === w1);
  watchlist.watch({ tagId });
  watchlist.watch({ phrase: "softwood lumber" });

  const list = watchlist.listWatchlist();
  check("all three kinds are listed", list.length === 3, JSON.stringify(list.map((w) => w.kind)));
  check("each carries a label", list.every((w) => w.label));
  check(
    "the kinds are named",
    list.map((w) => w.kind).sort().join() === "entity,phrase,topic"
  );

  check("unwatching works", watchlist.unwatch(w1) && !watchlist.isWatched(entityId));
  check("and the ids of watched entities are readable", watchlist.watchedEntityIds().length === 0);
}

/* --------------------------------------------------------------- brief */

section("The brief is a query, not a summary");
{
  const entityId = Number(
    db()
      .prepare("INSERT INTO entities (type, canonical_name, normalized) VALUES ('person','Chrystia Freeland','chrystia freeland')")
      .run().lastInsertRowid
  );
  watchlist.watch({ entityId });

  const now = new Date();
  const recent = new Date(now.getTime() - 3600_000).toISOString();
  const old = new Date(now.getTime() - 40 * 3600_000).toISOString();

  const mkSource = (title, at, outlet) =>
    Number(
      db()
        .prepare("INSERT INTO sources (title, kind, status, outlet, published_at) VALUES (?, 'url','ready',?,?)")
        .run(title, outlet, at).lastInsertRowid
    );
  const mkPassage = (sourceId, quote, claim) => {
    const chunkId = Number(
      db().prepare("INSERT INTO chunks (source_id, seq, text) VALUES (?, 0, ?)").run(sourceId, quote).lastInsertRowid
    );
    return Number(
      db()
        .prepare(
          "INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote, claim, attribution, claim_kind) VALUES (?,?,?,?,?,?,?,?)"
        )
        .run(entityId, chunkId, sourceId, "Freeland", quote, claim, "unnamed officials", "allegation").lastInsertRowid
    );
  };

  const fresh = mkSource("Freeland signals a deal", recent, "Reuters");
  const stale = mkSource("Freeland last year", old, "AP");
  const inWindow = mkPassage(fresh, "Freeland said the talks would continue into April.", "Talks continue");
  mkPassage(stale, "Freeland described the round as difficult.", "Round was difficult");

  // The brief is organised by topic. A watched entity still matters — it
  // decides which entries are kept current — but it no longer carves out a
  // section of its own, because four entities in one article used to print the
  // same passage four times.
  const tagId = Number(db().prepare("INSERT INTO tags (name) VALUES ('Canada trade')").run().lastInsertRowid);
  db().prepare("INSERT INTO source_tags (source_id, tag_id) VALUES (?, ?)").run(fresh, tagId);
  watchlist.watch({ tagId });

  const material = brief.gather(new Date(now.getTime() - 24 * 3600_000), new Date(now.getTime() + 60_000));
  check("the brief has material", brief.hasMaterial(material));
  check(
    "a watched entity gets no section of its own",
    !material.watched.some((w) => w.label === "Chrystia Freeland"),
    JSON.stringify(material.watched.map((w) => w.label))
  );
  const watched = material.watched.find((w) => w.label === "Canada trade");
  check("the watched topic has its passages", watched && watched.passages.length === 1, JSON.stringify(material.watched.map((w) => [w.label, w.passages.length])));
  check("only the passage inside the window is included", watched.passages[0].mention_id === inWindow);
  check("the outlet travels with it", watched.passages[0].outlet === "Reuters");
  check("so does the attribution", watched.passages[0].attribution === "unnamed officials");
  check("and the kind of claim", watched.passages[0].claim_kind === "allegation");
  check(
    "and it is not repeated in everything else",
    !material.other.some((p) => p.mention_id === inWindow)
  );
  check("the counts describe the window", material.counts.sources >= 1 && material.counts.passages >= 1);

  const empty = brief.gather(new Date(now.getTime() - 400 * 24 * 3600_000), new Date(now.getTime() - 399 * 24 * 3600_000));
  check("a window with nothing in it has no material", !brief.hasMaterial(empty));

  check("today's key is a local calendar day", /^\d{4}-\d{2}-\d{2}$/.test(brief.todayKey()));
}

/* ------------------------------------------------- a day off costs nothing */

section("A brief starts where the last one stopped");
// Take Friday off and Monday's brief must still carry Friday's reading. The
// configured window is a minimum, not the rule.
{
  const at = new Date("2026-09-14T09:00:00.000Z"); // a Monday
  const back = (h) => new Date(at.getTime() - h * 3600_000);
  const H = 24;

  check(
    "with no brief before it, the configured window stands",
    brief.dayWindowFrom(at, H).getTime() === back(24).getTime()
  );
  check(
    "a brief that stopped three days ago is where this one starts",
    brief.dayWindowFrom(at, H, back(72)).getTime() === back(72).getTime()
  );
  check(
    "the configured window is a floor, so a rewrite still looks back a day",
    brief.dayWindowFrom(at, H, back(0.5)).getTime() === back(24).getTime()
  );
  check(
    "and it never reaches back further than a fortnight",
    brief.dayWindowFrom(at, H, back(40 * 24)).getTime() === back(14 * 24).getTime()
  );

  const mk = (day, kind, state, to) =>
    db()
      .prepare("INSERT INTO briefs (day, kind, state, window_from, window_to) VALUES (?, ?, ?, ?, ?)")
      .run(day, kind, state, "2026-09-01T09:00:00.000Z", to);
  mk("2026-09-10", "day", "done", "2026-09-10T09:00:00.000Z");
  mk("2026-09-11", "day", "pending", "2026-09-11T09:00:00.000Z");
  mk("2026-W37", "week", "done", "2026-09-12T09:00:00.000Z");

  check(
    "the last finished daily brief is the one it follows",
    brief.coveredThrough("2026-09-14")?.toISOString() === "2026-09-10T09:00:00.000Z",
    String(brief.coveredThrough("2026-09-14"))
  );
  check(
    "an unfinished brief covered nothing, so it is not followed",
    brief.coveredThrough("2026-09-12")?.toISOString() === "2026-09-10T09:00:00.000Z"
  );
  check("a brief never starts where it itself ended", brief.coveredThrough("2026-09-10") === undefined);
  check(
    "and a weekly brief is not what a daily one follows",
    brief.coveredThrough("2026-09-13")?.toISOString() === "2026-09-10T09:00:00.000Z"
  );

  db().prepare("DELETE FROM briefs WHERE day IN ('2026-09-10','2026-09-11','2026-W37')").run();
}

/* ------------------------------------------------------- the queue */

section("Checking the feeds comes before chunking and parsing articles");
// A poll outranks the reading in claimNext, and the guard that queues the
// next check counts only polls — not the article fetches a poll left behind.
// Together these are what let an hourly feed be checked hourly while a book
// is being read, rather than once the book is done.
{
  const queue = await import("../lib/queue.ts");
  const poll = await import("../lib/pipeline/poll.ts");
  db().prepare("DELETE FROM tasks").run();
  db().prepare("DELETE FROM runs").run();

  // A long ingest, queued first: an extraction and an article fetch.
  const ingest = queue.createRun({ kind: "ingest", label: "A book" });
  queue.enqueue(ingest, [
    { kind: "extract", payload: { chunkId: 1 } },
    { kind: "fetch_item", payload: { itemId: 1 } },
  ]);
  check("with only fetches and extractions waiting, no poll is pending", !poll.pollPending());
  check("though the brief still sees the articles as in flight", poll.pollInFlight());

  // A poll, queued after — and claimed first.
  const polls = queue.createRun({ kind: "poll", label: "Checking feeds" });
  queue.enqueue(polls, [{ kind: "poll", payload: { feedId: 1 } }]);
  check("now a poll is pending", poll.pollPending());

  const first = queue.claimNext();
  check("the poll is claimed ahead of the older ingest", first && first.kind === "poll", first && first.kind);
  // The fetch is free and the inbox is waiting on it; the extraction, though
  // queued earlier, is a model call nobody is watching.
  const second = queue.claimNext();
  check("then the article fetch, ahead of the older extraction", second && second.kind === "fetch_item", second && second.kind);
  const third = queue.claimNext();
  check("and the reading resumes after that", third && third.kind === "extract", third && third.kind);
  check("a running poll still counts as pending", poll.pollPending());

  db().prepare("DELETE FROM tasks").run();
  db().prepare("DELETE FROM runs").run();
}

/* ------------------------------------------------------- story compiling */

section("Two accounts of one return are one story");
{
  const soon = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600e3).toISOString();
  const mk = (title, at, outlet, lede) => {
    const id = Number(
      db()
        .prepare("INSERT INTO sources (title, kind, status, outlet, published_at) VALUES (?, 'url', 'chunked', ?, ?)")
        .run(title, outlet, at).lastInsertRowid
    );
    if (lede) {
      db().prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, ?, '{}')").run(id, lede);
    }
    return id;
  };

  const A = "Mitch McConnell Returns to US Senate for First Time Since June";
  const B = "Mitch McConnell returns to the Senate after three-month absence";
  check("the headlines resemble each other", stories.titleSimilarity(A, B) >= 0.42, String(stories.titleSimilarity(A, B)));
  const a = mk(A, soon(6), "Bloomberg",
    "Mitch McConnell returned to the Senate on Monday. The Kentucky Republican had been away since June after a fall at his home.");
  const b = mk(B, soon(4), "The Hill",
    "Sen. Mitch McConnell was back in the Senate on Monday afternoon. The Kentucky Republican missed three months of votes.");
  const names = stories.namesIn("Sen. Mitch McConnell was back in the Senate on Monday afternoon. The Kentucky Republican missed votes.");
  check("names are read from the lede", names.has("mcconnell") && names.has("kentucky"), [...names].join(","));
  check("but not the ones every lede on the beat carries", !names.has("senate") && !names.has("monday"));
  check("and not the first word of a sentence", !names.has("sen"));
  check("unless the text keeps using it", stories.namesIn("Alberta voted on Monday. Alberta had never done so before.").has("alberta"));
  const s1 = stories.fileSource(a);
  const s2 = stories.fileSource(b);
  check("the rewrite joins the story on the names in the ledes", s2.storyId === s1.storyId, JSON.stringify([s1, s2]));

  const C = "Trump says tariffs on Canada will stay";
  const c = mk(C, soon(3), "CBC", "Donald Trump said on Tuesday that the tariffs on Canada would remain in place. Ottawa has not responded.");
  check("a different story about a different subject stays apart", stories.fileSource(c).storyId !== s1.storyId);
}

section("A column is not a story");
{
  const soon = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600e3).toISOString();
  const mk = (title, at, lede) => {
    const id = Number(
      db()
        .prepare("INSERT INTO sources (title, kind, status, outlet, published_at) VALUES (?, 'url', 'chunked', 'Semafor', ?)")
        .run(title, at).lastInsertRowid
    );
    db().prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, ?, '{}')").run(id, lede);
    return id;
  };
  check("a one-word identity cannot group on its own", !stories.titlesAgree("What in the World?", "What in the World?"));
  check("three words can", stories.titlesAgree("Ottawa resumes tariff talks", "Ottawa resumes tariff talks with Washington"));
  const w1 = mk("What in the World?", soon(30), "China moved first. Beijing announced new export controls on Tuesday, and Tokyo objected.");
  const w2 = mk("What in the World?", soon(2), "Brazil voted on Sunday. Lula won a narrow majority in Congress, and Brasília celebrated.");
  check("two instalments are two stories", stories.fileSource(w1).storyId !== stories.fileSource(w2).storyId);
}

section("Stories opened twice are folded together");
{
  const soon = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600e3).toISOString();
  const mk = (title, at, outlet) =>
    Number(
      db()
        .prepare("INSERT INTO sources (title, kind, status, outlet, published_at) VALUES (?, 'url', 'chunked', ?, ?)")
        .run(title, outlet, at).lastInsertRowid
    );
  const lede = (id, text) =>
    db().prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, 0, ?, '{}')").run(id, text);

  // Filed with nothing but headlines — the second opens its own story.
  const g = mk("Supreme court rejects Trump's mail ballot restrictions for midterms", soon(20), "Guardian");
  const n = mk("Supreme Court Denies Trump Request to Curb Mail Ballots", soon(18), "NYT");
  const sg = stories.fileSource(g);
  const sn = stories.fileSource(n);
  check("on headlines alone the rewrite opened a second story", sg.storyId !== sn.storyId);

  // Now the articles are in, and their ledes agree.
  lede(g, "The Supreme Court on Tuesday rejected the Trump administration's request. Officials in Pennsylvania and Wisconsin had challenged the order.");
  lede(n, "The Supreme Court declined on Tuesday to let the Trump administration restrict mail voting. Officials in Pennsylvania and Wisconsin welcomed the ruling.");
  const folded = stories.regroupRecent({ hours: 48 });
  check("the regroup folds them into one", folded >= 1, String(folded));
  const after = db().prepare("SELECT story_id FROM story_sources WHERE source_id IN (?, ?)").all(g, n);
  check("and both accounts are in it", after.length === 2 && after[0].story_id === after[1].story_id, JSON.stringify(after));
  check("a second pass has nothing to do", stories.regroupRecent({ hours: 48 }) === 0);
}

/* ------------------------------------------------------------- dedupe */

section("Tracking parameters are not part of an address");
{
  const { canonicalUrl } = await import("../lib/ingest/meta.ts");
  check(
    "the BBC's rss stamp is dropped",
    canonicalUrl("https://www.bbc.co.uk/news/articles/c0m3neyyzm7o?at_campaign=rss&at_medium=RSS") ===
      "https://www.bbc.co.uk/news/articles/c0m3neyyzm7o"
  );
  check("and the CBC's", canonicalUrl("https://www.cbc.ca/news/politics/x-9.7343922?cmp=rss") === "https://www.cbc.ca/news/politics/x-9.7343922");
  check("a parameter that is part of the page stays", canonicalUrl("https://x.example/list?page=2&utm_source=rss") === "https://x.example/list?page=2");
}

section("The same headline from the same outlet is one item");
{
  const mkFeed = (url, title, outlet) =>
    Number(db().prepare("INSERT INTO feeds (url, title, outlet) VALUES (?, ?, ?)").run(url, title, outlet).lastInsertRowid);
  const politics = mkFeed("https://x.example/politics/rss", "X politics", "X");
  const world = mkFeed("https://x.example/world/rss", "X world", "X");
  const other = mkFeed("https://y.example/rss", "Y", "Y");
  const title = "Ottawa names new ambassador to Mexico after a long delay";
  const item = (guid, url) => ({ guid, url, title, summary: null, publishedAt: new Date().toISOString() });

  const first = feeds.recordItems(politics, [item("p1", "https://x.example/politics/ambassador?utm_source=rss")], null);
  check("the first is new", first.length === 1);
  const second = feeds.recordItems(world, [item("w1", "https://x.example/world/ambassador-mexico")], null);
  check("the same words from a sister feed are a duplicate", second.length === 0);
  const row = db().prepare("SELECT state, note FROM feed_items WHERE guid='w1'").get();
  check("and say so", row.state === "duplicate" && /Same headline already offered by X politics/.test(row.note), JSON.stringify(row));
  const third = feeds.recordItems(other, [item("y1", "https://y.example/ambassador")], null);
  check("the same words from another outlet are an account of the story, not a duplicate", third.length === 1);
}

section("Held back is not lost");
{
  const feedId = Number(
    db().prepare("INSERT INTO feeds (url, title, outlet, daily_cap) VALUES ('https://cap.example/rss', 'Capped', 'Cap', 2)").run().lastInsertRowid
  );
  const items = [1, 2, 3, 4, 5].map((n) => ({
    guid: `c${n}`,
    url: `https://cap.example/${n}`,
    title: `Capped item number ${n} of the morning`,
    summary: null,
    publishedAt: new Date(Date.now() - n * 3600e3).toISOString(),
  }));
  const fresh = feeds.recordItems(feedId, items, null);
  check("five arrive", fresh.length === 5);
  const waiting = feeds.heldBack(feedId);
  check("all five wait, newest first", waiting.length === 5 && waiting[0] === fresh[0], JSON.stringify(waiting));
  feeds.markQueued(waiting.slice(0, 2));
  check("taking two counts two against today", feeds.ingestedToday(feedId) === 2);
  check("and three still wait", feeds.heldBack(feedId).length === 3);
  db().prepare("UPDATE feed_items SET seen_at = datetime('now', '-4 days') WHERE guid = 'c5'").run();
  check("one that has waited too long is let go", feeds.expireHeldBack(feedId) === 1);
  const gone = db().prepare("SELECT state, note FROM feed_items WHERE guid='c5'").get();
  check("and says why", gone.state === "skipped" && /Expired unread/.test(gone.note), JSON.stringify(gone));
  check("the other two still wait", feeds.heldBack(feedId).length === 2);
}

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
