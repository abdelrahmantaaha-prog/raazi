import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { Piece } from "../chunk";
import { parseText } from "./text";

export interface WebParse {
  pieces: Piece[];
  meta: { title?: string; author?: string; publisher?: string; year?: string; lang?: string };
}

/** Fetches an article and keeps the readable body, dropping nav and ads. */
export async function parseUrl(url: string): Promise<WebParse> {
  const res = await fetch(url, {
    headers: {
      // Some publishers serve a stub to unknown agents.
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

  const html = await res.text();
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const metaOf = (sel: string) =>
    doc.querySelector(sel)?.getAttribute("content")?.trim() || undefined;

  const published =
    metaOf('meta[property="article:published_time"]') ??
    metaOf('meta[name="date"]') ??
    doc.querySelector("time[datetime]")?.getAttribute("datetime") ??
    undefined;

  const meta = {
    title: metaOf('meta[property="og:title"]') ?? (doc.title?.trim() || undefined),
    author: metaOf('meta[name="author"]') ?? metaOf('meta[property="article:author"]'),
    publisher: metaOf('meta[property="og:site_name"]') ?? new URL(url).hostname,
    year: published?.slice(0, 4),
    lang: doc.documentElement.getAttribute("lang") ?? undefined,
  };

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

  const label = meta.title ?? new URL(url).hostname;
  const pieces = parseText(body).map((p) => ({
    ...p,
    label: p.label === "Text" ? label : p.label,
  }));

  return { pieces, meta };
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
