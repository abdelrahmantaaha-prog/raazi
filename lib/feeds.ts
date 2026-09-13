import { JSDOM } from "jsdom";
import { db, tx } from "./db";
import { safeFetch } from "./net";
import { canonicalUrl, outletFromUrl, toPublishedAt } from "./ingest/meta";

/**
 * Feeds: what a beat actually looks like from the outside.
 *
 * A research library grew one book at a time and could afford to be told about
 * each one. A news beat cannot: the sources arrive on their own, from places
 * you chose once, and the only decisions worth making by hand are which places
 * and which stories. So a feed is a standing instruction — poll this, file what
 * it carries under these topics, at most this many a day — and everything after
 * that is the ordinary ingest path.
 *
 * Parsing is done here rather than with a library because RSS and Atom between
 * them are a handful of element names, and the two things that actually matter
 * are the ones a generic parser gets wrong: which element is the *stable* id
 * for an item, and which of five date spellings is its publication time.
 */

export interface Feed {
  id: number;
  url: string;
  title: string;
  outlet: string | null;
  kind: "rss" | "atom" | "youtube" | "page";
  reliability: string | null;
  enabled: number;
  interval_minutes: number;
  daily_cap: number;
  since: string | null;
  last_polled_at: string | null;
  last_status: string | null;
  etag: string | null;
  last_modified: string | null;
  added_at: string;
  /** For a watched page: part of the address every article link shares
   *  ("ArticleID/"), or a /regex/. Null means "links that read as headlines". */
  link_pattern: string | null;
}

export interface FeedItem {
  guid: string;
  url: string | null;
  title: string;
  summary: string | null;
  publishedAt: string | null;
  /** A picture the feed offered for the item, when it offered one. */
  image?: string | null;
}

export interface ParsedFeed {
  kind: "rss" | "atom" | "page";
  title: string;
  outlet: string | null;
  items: FeedItem[];
}

/**
 * A page with no feed, read as one.
 *
 * Plenty of places worth watching publish a list and nothing else — a
 * foundation's news page, a ministry, a court. This reads the page's links
 * the way a person scanning it would: the ones that read as headlines, on the
 * same site, outside the navigation. Each becomes an item whose id is its
 * address, so a link seen once is never an item twice, and a link that was
 * not there last time is news.
 *
 * A pattern narrows it when the page is noisy: part of the address every
 * article shares ("ArticleID/"), or a /regex/. The same link often appears
 * twice — once under its headline and once as a "More" button — so links are
 * folded by address and the longest wording kept as the title.
 */
export function parsePage(html: string, pageUrl: string, pattern?: string | null): ParsedFeed {
  const doc = new JSDOM(html, { url: pageUrl }).window.document;
  const page = new URL(pageUrl);
  const host = page.hostname.replace(/^www\./, "");
  const pageKey = page.origin + page.pathname.replace(/\/+$/, "") + page.search;

  const test = matcher(pattern);
  const items = new Map<string, FeedItem>();

  for (const a of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (a.closest("nav, header, footer, aside, [role='navigation'], [role='banner'], [role='contentinfo']")) continue;
    let u: URL;
    try {
      u = new URL(a.getAttribute("href") ?? "", pageUrl);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (u.hostname.replace(/^www\./, "") !== host) continue;
    u.hash = "";
    const key = u.origin + u.pathname.replace(/\/+$/, "") + u.search;
    if (key === pageKey) continue;

    const text = (a.textContent ?? "").replace(/\s+/g, " ").trim() || (a.getAttribute("title") ?? "").trim();
    if (test) {
      if (!test(u.href)) continue;
    } else if (!readsAsHeadline(text)) {
      continue;
    }

    const url = u.href;
    const have = items.get(key);
    if (!have) {
      items.set(key, { guid: canonicalUrl(url) ?? url, url, title: text || url, summary: null, publishedAt: null, image: null });
    } else if (text.length > have.title.length && !isMoreButton(text)) {
      have.title = text;
    }
    if (items.size >= 200) break;
  }

  // A pattern-matched link whose only wording was "More" gets its address
  // as a title, which the fetch replaces with the page's own once it is read.
  for (const it of items.values()) if (isMoreButton(it.title)) it.title = it.url ?? it.title;

  const siteName =
    doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim() ||
    doc.title?.trim() ||
    host;
  return { kind: "page", title: siteName, outlet: outletFromUrl(pageUrl) ?? siteName, items: [...items.values()] };
}

/** "More", "Read more", "المزيد" and the like: a link's button, not its title. */
function isMoreButton(text: string): boolean {
  return /^(more|read more|continue reading|learn more|details|المزيد|اقرأ المزيد|التفاصيل|→|»|\.{3}|…)$/i.test(text.trim());
}

/** Three words, or the length of a short headline in any script. */
function readsAsHeadline(text: string): boolean {
  const t = text.trim();
  if (!t || isMoreButton(t)) return false;
  return t.split(/\s+/).length >= 3 || t.length >= 24;
}

function matcher(pattern?: string | null): ((href: string) => boolean) | null {
  const p = pattern?.trim();
  if (!p) return null;
  const re = /^\/(.+)\/([a-z]*)$/.exec(p);
  if (re) {
    try {
      const rx = new RegExp(re[1], re[2].replace(/[^gimsuy]/g, ""));
      return (href) => rx.test(href) || rx.test(decodeURIComponent(href));
    } catch {
      /* fall through to a plain substring */
    }
  }
  const needle = p.toLowerCase();
  return (href) => href.toLowerCase().includes(needle) || safeDecode(href).toLowerCase().includes(needle);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The feed a page advertises in its head, when it advertises one. */
export function discoverFeedUrl(html: string, pageUrl: string): string | null {
  const doc = new JSDOM(html, { url: pageUrl }).window.document;
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel~="alternate"][href]')) {
    const type = (link.getAttribute("type") ?? "").toLowerCase();
    if (!/rss|atom|xml/.test(type)) continue;
    try {
      return new URL(link.getAttribute("href")!, pageUrl).href;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Whether a body is a web page rather than a feed. */
export function looksLikeHtml(body: string, contentType?: string | null): boolean {
  if (/text\/html/i.test(contentType ?? "")) return true;
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(body.slice(0, 512));
}

/**
 * Reads an RSS 2.0 or Atom document.
 *
 * The id rule is the whole game. RSS `<guid>` is stable when it is there;
 * Atom `<id>` likewise. Falling back to the link is right, and falling back to
 * the title is a last resort — a headline that gets corrected an hour later
 * would otherwise arrive as a second story, which is exactly the noise this is
 * meant to remove.
 */
export function parseFeed(xml: string): ParsedFeed {
  const doc = new JSDOM(xml, { contentType: "text/xml" }).window.document;
  if (doc.querySelector("parsererror")) throw new Error("That did not parse as a feed.");

  const text = (el: Element | null | undefined) => el?.textContent?.trim() || "";
  const first = (parent: Element, ...names: string[]): Element | null => {
    for (const n of names) {
      // Namespaced elements ("dc:date") are matched by local name, since the
      // XML parser keeps the prefix in tagName but not always in querySelector.
      const hit =
        parent.querySelector(`:scope > ${n}`) ??
        [...parent.children].find((c) => c.tagName.toLowerCase().replace(/^.*:/, "") === n);
      if (hit) return hit;
    }
    return null;
  };

  const isAtom = doc.documentElement.tagName.toLowerCase().replace(/^.*:/, "") === "feed";
  const channel = isAtom ? doc.documentElement : doc.querySelector("channel") ?? doc.documentElement;
  const entries = [...doc.getElementsByTagName(isAtom ? "entry" : "item")];

  const items: FeedItem[] = entries.map((e) => {
    const link = isAtom
      ? ([...e.children].find(
          (c) =>
            c.tagName.toLowerCase().replace(/^.*:/, "") === "link" &&
            (c.getAttribute("rel") ?? "alternate") === "alternate"
        )?.getAttribute("href") ?? text(first(e, "link")))
      : text(first(e, "link")) || first(e, "guid")?.textContent?.trim() || "";

    const published =
      text(first(e, "published", "pubDate", "date", "updated", "created")) || null;

    const title = text(first(e, "title")) || "(untitled)";
    const guid = text(first(e, "guid", "id")) || link || title;
    const summary = text(first(e, "description", "summary", "content"));

    return {
      guid,
      url: link || null,
      title,
      summary: summary.slice(0, 2000) || null,
      publishedAt: published ? toPublishedAt(published) : null,
      image: itemImage(e, summary, link),
    };
  });

  return {
    kind: isAtom ? "atom" : "rss",
    title: text(first(channel, "title")) || "Untitled feed",
    outlet: text(first(channel, "title")) || null,
    items,
  };
}

/**
 * The picture a feed item carries, if any.
 *
 * Publishers put it in four places: Media RSS `media:content` (when it is an
 * image — the same element carries video), `media:thumbnail`, an
 * `enclosure` with an image type, or an `<img>` inside the description.
 * Checked in that order, since the first two are chosen by the publisher for
 * exactly this purpose and the last is whatever the article opened with.
 * Relative addresses resolve against the item link. A one-pixel image is a
 * tracker, not a picture.
 */
export function itemImage(e: Element, summary: string, link: string): string | null {
  const local = (el: Element) => el.tagName.toLowerCase().replace(/^.*:/, "");
  const children = [...e.getElementsByTagName("*")];
  const pick = (name: string, ok: (el: Element) => boolean = () => true) =>
    children.find((c) => local(c) === name && c.getAttribute("url") && ok(c))?.getAttribute("url") ?? null;

  const media =
    pick("content", (c) => {
      const medium = (c.getAttribute("medium") ?? "").toLowerCase();
      const type = (c.getAttribute("type") ?? "").toLowerCase();
      if (medium) return medium === "image";
      if (type) return type.startsWith("image/");
      return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(c.getAttribute("url") ?? "");
    }) ??
    pick("thumbnail") ??
    children
      .find((c) => local(c) === "enclosure" && /^image\//i.test(c.getAttribute("type") ?? ""))
      ?.getAttribute("url") ??
    null;

  let candidate = media;
  if (!candidate && summary) {
    const tag = /<img\b[^>]*>/i.exec(summary)?.[0];
    if (tag) {
      const src = /\bsrc=["']([^"']+)["']/i.exec(tag);
      const width = /\bwidth=["']?(\d+)/i.exec(tag);
      const height = /\bheight=["']?(\d+)/i.exec(tag);
      const pixel = (width && Number(width[1]) <= 1) || (height && Number(height[1]) <= 1);
      if (src && !pixel) candidate = src[1];
    }
  }
  if (!candidate) return null;
  try {
    const u = new URL(candidate, link || undefined);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString().slice(0, 1000);
  } catch {
    return null;
  }
}

/** A YouTube channel or playlist has a feed; this is where it lives. */
export function youtubeFeedUrl(url: string): string | null {
  const channel = /youtube\.com\/channel\/([A-Za-z0-9_-]+)/.exec(url);
  if (channel) return `https://www.youtube.com/feeds/videos.xml?channel_id=${channel[1]}`;
  const playlist = /[?&]list=([A-Za-z0-9_-]+)/.exec(url);
  if (playlist) return `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlist[1]}`;
  return null;
}

/** A search on Google News, as a feed. The cheapest way to watch a phrase. */
export function newsQueryFeedUrl(query: string, lang = "en", country = "US"): string {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=${lang}&gl=${country}&ceid=${country}:${lang}`;
}

/**
 * The same search on Bing News.
 *
 * Worth having beside Google's because of what happens after the click. Google
 * News hands back an opaque redirect only Google can resolve, so an article
 * found there is a headline and nothing more; Bing wraps the link too, but
 * carries the real address in a query parameter, which unwrapRedirect recovers.
 * For watching a phrase Google's coverage is better and a headline is enough.
 * For a search you intend to read, this is the one that yields articles.
 */
export function bingNewsQueryUrl(query: string, market = "en-US"): string {
  const q = encodeURIComponent(query);
  return `https://www.bing.com/news/search?q=${q}&format=RSS&setmkt=${market}`;
}

/**
 * Fetches a feed, honouring the caching headers it gave us last time.
 *
 * A 304 is the polite outcome and the common one: most polls of most feeds
 * should cost a few hundred bytes and no parsing at all.
 */
/**
 * Fetches a feed and reads it.
 *
 * A watched page (`kind: "page"`) is read as one. A feed of no stated kind —
 * the moment it is being added — that turns out to be a web page is handed
 * back as `html` rather than parsed, so the caller can look for the feed the
 * page advertises, or watch the page itself. A feed of a stated kind that
 * starts returning HTML is a broken feed, and says so.
 */
export async function fetchFeed(
  feed: Pick<Feed, "url" | "etag" | "last_modified"> & { kind?: Feed["kind"]; link_pattern?: string | null }
): Promise<{ status: number; parsed?: ParsedFeed; html?: string; etag?: string; lastModified?: string }> {
  const page = feed.kind === "page";
  const headers: Record<string, string> = {
    accept: page
      ? "text/html, application/xhtml+xml;q=0.9, */*;q=0.5"
      : "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, text/html;q=0.7, */*;q=0.5",
    "user-agent": "Corpus/1.0 (personal research reader)",
  };
  if (feed.etag) headers["if-none-match"] = feed.etag;
  if (feed.last_modified) headers["if-modified-since"] = feed.last_modified;

  const res = await safeFetch(feed.url, { headers });
  if (res.status === 304) return { status: 304 };
  if (!res.ok) throw new Error(`Feed returned ${res.status} ${res.statusText}`);

  const body = await res.text();
  const meta = {
    status: res.status,
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
  };
  if (page) return { ...meta, parsed: parsePage(body, res.url || feed.url, feed.link_pattern) };
  if (looksLikeHtml(body, res.headers.get("content-type"))) {
    if (feed.kind) throw new Error("That address now returns a web page, not a feed.");
    return { ...meta, html: body };
  }
  return { ...meta, parsed: parseFeed(body) };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function listFeeds(): (Feed & { items: number; ready: number; pending: number })[] {
  return db()
    .prepare(
      `SELECT f.*,
              (SELECT COUNT(*) FROM feed_items i WHERE i.feed_id=f.id) AS items,
              (SELECT COUNT(*) FROM feed_items i WHERE i.feed_id=f.id AND i.state='ready') AS ready,
              (SELECT COUNT(*) FROM feed_items i WHERE i.feed_id=f.id AND i.state IN ('new','queued')) AS pending
         FROM feeds f ORDER BY f.enabled DESC, f.title`
    )
    .all() as (Feed & { items: number; ready: number; pending: number })[];
}

export function getFeed(id: number): Feed | undefined {
  return db().prepare("SELECT * FROM feeds WHERE id=?").get(id) as Feed | undefined;
}

/**
 * Adds a feed after checking it is one.
 *
 * The fetch happens before the row is written on purpose: a feed that does not
 * parse is a typo, and a list of feeds that quietly contains three typos is
 * worse than an error at the moment you can still see what you pasted.
 */
export async function addFeed(opts: {
  url: string;
  title?: string;
  outlet?: string;
  reliability?: string;
  intervalMinutes?: number;
  dailyCap?: number;
  tags?: number[];
  /** Only ingest items published after this. Defaults to now, so adding a feed
   *  does not read its archive. */
  since?: string | null;
  /** For a page with no feed: part of the address every article shares. */
  linkPattern?: string | null;
}): Promise<{ id: number; title: string; items: number; kind: Feed["kind"] }> {
  let url = youtubeFeedUrl(opts.url) ?? opts.url;
  const pattern = opts.linkPattern?.trim() || null;
  let result = await fetchFeed({ url, etag: null, last_modified: null, link_pattern: pattern });

  // A web page rather than a feed. If it advertises a feed, follow that — a
  // real feed carries dates and ids a scrape never will. Otherwise watch the
  // page itself for links it did not have last time.
  if (!result.parsed && result.html) {
    const html = result.html;
    const advertised = discoverFeedUrl(html, url);
    if (advertised && advertised !== url) {
      try {
        const viaFeed = await fetchFeed({ url: advertised, etag: null, last_modified: null, kind: "rss" });
        if (viaFeed.parsed && viaFeed.parsed.items.length) {
          url = advertised;
          result = viaFeed;
        }
      } catch {
        /* the page it is, then */
      }
    }
    if (!result.parsed) {
      const parsed = parsePage(html, url, pattern);
      if (parsed.items.length === 0) {
        throw new Error(
          pattern
            ? `No links on that page match "${pattern}".`
            : "No article links found on that page. Give a link pattern — part of the address every article shares, such as ArticleID/ — and try again."
        );
      }
      result = { ...result, parsed };
    }
  }
  if (!result.parsed) throw new Error("The feed did not return anything to read.");
  const parsed = result.parsed;

  const kind: Feed["kind"] = youtubeFeedUrl(opts.url) ? "youtube" : parsed.kind;
  const since = opts.since === null ? null : (opts.since ?? new Date().toISOString());
  const id = tx(() => {
    const info = db()
      .prepare(
        `INSERT INTO feeds (url, title, outlet, kind, reliability, interval_minutes, daily_cap, since, link_pattern)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        url,
        opts.title?.trim() || parsed.title,
        opts.outlet?.trim() || parsed.outlet,
        kind,
        opts.reliability?.trim() || null,
        opts.intervalMinutes ?? 60,
        opts.dailyCap ?? 40,
        since,
        kind === "page" ? pattern : null
      );
    const feedId = Number(info.lastInsertRowid);
    for (const tagId of opts.tags ?? []) {
      db().prepare("INSERT OR IGNORE INTO feed_tags (feed_id, tag_id) VALUES (?, ?)").run(feedId, tagId);
    }
    // A page's links carry no dates, so `since` cannot tell the old from the
    // new. What is on the page now is recorded as already seen; from here on
    // a link that was not there last time is what arrives. Unless you asked to
    // read what it is already carrying.
    if (kind === "page" && since !== null) recordItems(feedId, parsed.items, null, { seed: true });
    return feedId;
  });

  return { id, title: opts.title?.trim() || parsed.title, items: parsed.items.length, kind };
}

export function updateFeed(
  id: number,
  patch: Partial<Pick<Feed, "title" | "outlet" | "reliability" | "enabled" | "interval_minutes" | "daily_cap">>
): boolean {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k}=?`);
    values.push(v);
  }
  if (!fields.length) return false;
  const r = db().prepare(`UPDATE feeds SET ${fields.join(", ")} WHERE id=?`).run(...values, id);
  return r.changes > 0;
}

export function deleteFeed(id: number): boolean {
  return db().prepare("DELETE FROM feeds WHERE id=?").run(id).changes > 0;
}

export function feedTags(feedId: number): number[] {
  return (
    db().prepare("SELECT tag_id FROM feed_tags WHERE feed_id=?").all(feedId) as { tag_id: number }[]
  ).map((r) => r.tag_id);
}

export function setFeedTags(feedId: number, tagIds: number[]) {
  tx(() => {
    db().prepare("DELETE FROM feed_tags WHERE feed_id=?").run(feedId);
    const stmt = db().prepare("INSERT OR IGNORE INTO feed_tags (feed_id, tag_id) VALUES (?, ?)");
    for (const t of tagIds) stmt.run(feedId, t);
  });
}

/** Feeds whose interval has elapsed, soonest-overdue first. */
export function dueFeeds(now = new Date()): Feed[] {
  return db()
    .prepare(
      `SELECT * FROM feeds
        WHERE enabled = 1
          AND (last_polled_at IS NULL
               OR datetime(last_polled_at, '+' || interval_minutes || ' minutes') <= ?)
        ORDER BY COALESCE(last_polled_at, '') ASC`
    )
    .all(now.toISOString().replace("T", " ").slice(0, 19)) as Feed[];
}

/**
 * When the next feed falls due, so the worker can set an alarm for it.
 *
 * Without this "the feeds check themselves while Corpus is open" was only true
 * for the thirty seconds after the queue emptied: the idle loop swept the
 * feeds, stood down, and nothing brought it back until the morning timer or a
 * page you happened to open. An hourly interval was a wish. A feed never
 * polled is due now.
 */
export function nextFeedDueAt(): Date | undefined {
  const row = db()
    .prepare(
      `SELECT MIN(CASE WHEN last_polled_at IS NULL THEN datetime('now')
                       ELSE datetime(last_polled_at, '+' || interval_minutes || ' minutes') END) AS due
         FROM feeds WHERE enabled = 1`
    )
    .get() as { due: string | null };
  if (!row.due) return undefined;
  // SQLite's datetime() is UTC without a zone marker.
  const d = new Date(row.due.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** How many items this feed has turned into sources today. */
export function ingestedToday(feedId: number): number {
  return (
    db()
      .prepare(
        `SELECT COUNT(*) AS n FROM feed_items
          WHERE feed_id=? AND state IN ('queued','ready') AND date(seen_at)=date('now','localtime')`
      )
      .get(feedId) as { n: number }
  ).n;
}

/**
 * Whether this address is already in the library.
 *
 * Checked against both the sources table and the item log, because the same
 * story reaches you twice for two different reasons: two feeds carrying one
 * wire report (same canonical address, different guids) and one feed
 * republishing an item under a new guid after an edit.
 */
export function alreadyHave(canonical: string | null, url: string | null): { sourceId?: number; itemId?: number } {
  if (!canonical && !url) return {};
  const source = db()
    .prepare(
      `SELECT id FROM sources
        WHERE (canonical_url IS NOT NULL AND canonical_url = @canonical)
           OR (url IS NOT NULL AND url = @url)
        LIMIT 1`
    )
    .get({ canonical: canonical ?? " ", url: url ?? " " }) as { id: number } | undefined;
  if (source) return { sourceId: source.id };

  const item = db()
    .prepare(
      `SELECT id FROM feed_items
        WHERE canonical_url IS NOT NULL AND canonical_url = @canonical AND state <> 'failed'
        LIMIT 1`
    )
    .get({ canonical: canonical ?? " " }) as { id: number } | undefined;
  return item ? { itemId: item.id } : {};
}

/** Records what a poll found. Returns the ids of items worth ingesting. */
export function recordItems(
  feedId: number,
  items: FeedItem[],
  since: string | null,
  opts: {
    /** Record as already seen, never to be read: what a watched page held
     *  the day it was added. */
    seed?: boolean;
  } = {}
): number[] {
  const insert = db().prepare(
    `INSERT OR IGNORE INTO feed_items (feed_id, guid, url, canonical_url, title, summary, published_at, state, image_url, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const fresh: number[] = [];

  tx(() => {
    for (const item of items) {
      const canonical = item.url ? canonicalUrl(item.url) : null;
      // Older than the day the feed was added: recorded, never ingested. The
      // row still matters — it is what stops the archive arriving later.
      const tooOld = since && item.publishedAt && item.publishedAt < since;
      const seen = alreadyHave(canonical, item.url);
      const state = opts.seed || tooOld ? "skipped" : seen.sourceId || seen.itemId ? "duplicate" : "new";

      const info = insert.run(
        feedId,
        item.guid,
        item.url,
        canonical,
        item.title,
        item.summary,
        item.publishedAt,
        state,
        item.image ?? null,
        opts.seed ? "On the page when it was added." : null
      );
      if (info.changes === 0) continue; // already known under this guid

      const id = Number(info.lastInsertRowid);
      if (state === "duplicate" && seen.sourceId) {
        db().prepare("UPDATE feed_items SET source_id=?, note='Already in the library.' WHERE id=?").run(seen.sourceId, id);
      }
      if (state === "new") fresh.push(id);
    }
  });

  return fresh;
}

export function markPolled(feedId: number, status: string, etag?: string, lastModified?: string) {
  db()
    .prepare(
      `UPDATE feeds SET last_polled_at=datetime('now'), last_status=?,
              etag=COALESCE(?, etag), last_modified=COALESCE(?, last_modified)
        WHERE id=?`
    )
    .run(status, etag ?? null, lastModified ?? null, feedId);
}
