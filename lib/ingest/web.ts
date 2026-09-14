import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";

import type { Piece } from "../chunk";
import { safeFetch } from "../net";
import { parseText } from "./text";
import { canonicalUrl, normaliseLang, outletFromUrl, toPublishedAt } from "./meta";
/** jsdom shouts every stylesheet it cannot parse to the console — modern CSS it
 *  does not know, whole sheets of it, into the server log on every article
 *  fetched. Nothing here needs the styles. A console with no listeners is quiet. */
const quiet = () => new VirtualConsole();

export { canonicalUrl, normaliseLang, outletFromUrl, toPublishedAt } from "./meta";

export interface WebMeta {
  title?: string;
  author?: string;
  /** og:site_name, or the host. Kept alongside `outlet` for older callers. */
  publisher?: string;
  outlet?: string;
  section?: string;
  /** Full ISO datetime when the page declares one. */
  publishedAt?: string;
  year?: string;
  lang?: string;
  canonicalUrl?: string;
  /** The page's own picture — og:image or twitter:image — as an absolute address. */
  image?: string;
}

export interface WebParse {
  pieces: Piece[];
  meta: WebMeta;
}

/** Fetches an article and keeps the readable body, dropping nav and ads. */
export async function parseUrl(url: string): Promise<WebParse> {
  const res = await safeFetch(url, {
    headers: {
      // Some publishers serve a stub to unknown agents.
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

  const html = await res.text();
  // Relative links and rel=canonical resolve against where the page actually
  // came from, which after a redirect is not the address that was pasted.
  const finalUrl = res.url || url;
  const dom = new JSDOM(html, { url: finalUrl, virtualConsole: quiet() });
  const doc = dom.window.document;
  const meta = readMeta(doc, finalUrl);

  dropOverlays(doc);
  const article = new Readability(doc).parse();

  // Readability's textContent flattens the article into one undifferentiated
  // wall, which loses every heading the chunker could have split on. Its HTML
  // still has the structure, so convert that to Markdown instead.
  const body = article?.content
    ? htmlToMarkdown(article.content)
    : article?.textContent?.trim();

  if (!body || body.length < 200) {
    throw new Error("Could not extract readable article text from that page.");
  }

  if (article?.title && !meta.title) meta.title = article.title;
  if (article?.byline && !meta.author) meta.author = article.byline;

  const label = meta.title ?? new URL(finalUrl).hostname;
  const pieces = parseText(body).map((p) => ({
    ...p,
    label: p.label === "Text" ? label : p.label,
  }));

  return { pieces, meta };
}

/** A loading screen, spinner or splash, by the names sites give them. The
 *  word has to stand alone in the name — "page-loaders" and "loading-center"
 *  are overlays, "lazyload" is an image that is part of the article. */
const OVERLAY = /(?:^|[\s_-])(?:pre)?load(?:er|ers|ing)(?:$|[\s_-])|spinner|splash/i;

/** More text than any loading screen carries. Some sites leave `is-loading`
 *  on the container the article itself sits in until a script clears it. */
const OVERLAY_MAX_CHARS = 300;

/**
 * Removes the page's loading screen before Readability chooses the article.
 *
 * A loader is a logo and a line — Shoman's is the foundation's tagline — and
 * it sits in the markup ahead of everything, hidden by a script the reader
 * never runs. Readability judged that line part of the article, so every piece
 * from the site opened with it: in the inbox, in the chunks, and in whatever
 * an entry quoted from the top of the piece. Only elements named like
 * overlays go, and only small ones, so a mislabelled container keeps its
 * article. Exported for the tests.
 */
export function dropOverlays(doc: Document): number {
  let dropped = 0;
  for (const el of Array.from(doc.querySelectorAll("[class], [id]"))) {
    if (!el.isConnected) continue;
    const name = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`;
    if (!OVERLAY.test(name)) continue;
    if ((el.textContent ?? "").trim().length > OVERLAY_MAX_CHARS) continue;
    el.remove();
    dropped++;
  }
  return dropped;
}

/**
 * What the page says about itself, from the tags publishers actually fill in.
 * Exported so the feed poller can read the same fields from HTML it already
 * holds.
 */
export function readMeta(doc: Document, url: string): WebMeta {
  const metaOf = (sel: string) =>
    doc.querySelector(sel)?.getAttribute("content")?.trim() || undefined;

  const publishedRaw =
    metaOf('meta[property="article:published_time"]') ??
    metaOf('meta[name="article:published_time"]') ??
    metaOf('meta[property="og:published_time"]') ??
    metaOf('meta[name="pubdate"]') ??
    metaOf('meta[name="publishdate"]') ??
    metaOf('meta[name="date"]') ??
    metaOf('meta[name="dc.date"]') ??
    metaOf('meta[name="DC.date.issued"]') ??
    metaOf('meta[itemprop="datePublished"]') ??
    doc.querySelector("time[datetime]")?.getAttribute("datetime")?.trim() ??
    undefined;
  const publishedAt = toPublishedAt(publishedRaw) ?? undefined;

  const declaredCanonical =
    doc.querySelector('link[rel="canonical"]')?.getAttribute("href")?.trim() ||
    metaOf('meta[property="og:url"]');

  const siteName = metaOf('meta[property="og:site_name"]') ?? metaOf('meta[name="application-name"]');
  const outlet = siteName ?? outletFromUrl(url) ?? undefined;

  let image: string | undefined;
  const declaredImage =
    metaOf('meta[property="og:image:secure_url"]') ??
    metaOf('meta[property="og:image"]') ??
    metaOf('meta[name="og:image"]') ??
    metaOf('meta[name="twitter:image"]') ??
    metaOf('meta[name="twitter:image:src"]');
  if (declaredImage) {
    try {
      const u = new URL(declaredImage, url);
      if (u.protocol === "http:" || u.protocol === "https:") image = u.toString().slice(0, 1000);
    } catch {
      // A malformed image address is no image.
    }
  }

  return {
    title: metaOf('meta[property="og:title"]') ?? (doc.title?.trim() || undefined),
    author:
      metaOf('meta[name="author"]') ??
      metaOf('meta[property="article:author"]') ??
      metaOf('meta[name="dc.creator"]') ??
      metaOf('meta[name="parsely-author"]'),
    publisher: outlet,
    outlet,
    section: metaOf('meta[property="article:section"]') ?? metaOf('meta[name="section"]'),
    publishedAt,
    year: publishedAt?.slice(0, 4),
    lang:
      normaliseLang(doc.documentElement.getAttribute("lang")) ??
      normaliseLang(metaOf('meta[property="og:locale"]')) ??
      undefined,
    canonicalUrl: canonicalUrl(url, declaredCanonical) ?? undefined,
    image,
  };
}

/**
 * Just enough HTML to Markdown for article bodies. Headings and lists are what
 * matter — they give the chunker somewhere sensible to cut. Images, scripts and
 * figure captions are dropped: they cost tokens and carry no argument.
 */
export function htmlToMarkdown(html: string): string {
  let s = html;

  s = s.replace(/<(script|style|noscript|svg|figure|figcaption|aside)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  for (let level = 1; level <= 6; level++) {
    s = s.replace(
      new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, "gi"),
      (_, inner: string) => `\n\n${"#".repeat(level)} ${strip(inner)}\n\n`
    );
  }

  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => `\n- ${strip(inner)}`);
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner: string) =>
    `\n\n> ${strip(inner).replace(/\n+/g, "\n> ")}\n\n`
  );
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner: string) => `**${strip(inner)}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner: string) => `*${strip(inner)}*`);

  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|tr|ul|ol|table)>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");

  return decode(s)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

function strip(html: string): string {
  return decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}
