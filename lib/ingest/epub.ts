import { unzipSync, strFromU8 } from "fflate";
import type { Piece } from "../chunk";

export interface EpubParse {
  pieces: Piece[];
  meta: { title?: string; author?: string; lang?: string; publisher?: string; year?: string };
}

/**
 * EPUB is a zip of XHTML plus a manifest. Walking the spine in order preserves
 * reading order and chapter titles — which makes it the cheapest and most
 * accurate source format by a wide margin. No LLM involved at all.
 */
export function parseEpub(bytes: Buffer): EpubParse {
  const files = unzipSync(new Uint8Array(bytes));
  const names = Object.keys(files);
  const read = (name: string) => strFromU8(files[name]);

  const opfName =
    names.find((n) => n.toLowerCase().endsWith(".opf")) ??
    names.find((n) => n.toLowerCase().includes("content.opf"));
  if (!opfName) throw new Error("Not a readable EPUB: no OPF manifest found.");

  const opf = read(opfName);
  const base = opfName.includes("/") ? opfName.slice(0, opfName.lastIndexOf("/") + 1) : "";

  const meta = {
    title: tag(opf, "dc:title") ?? tag(opf, "title"),
    author: tag(opf, "dc:creator") ?? tag(opf, "creator"),
    lang: tag(opf, "dc:language") ?? tag(opf, "language"),
    publisher: tag(opf, "dc:publisher"),
    year: (tag(opf, "dc:date") ?? "").slice(0, 4) || undefined,
  };

  // manifest id -> href
  const hrefById = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = attr(m[0], "id");
    const href = attr(m[0], "href");
    if (id && href) hrefById.set(id, href);
  }

  const spine = [...opf.matchAll(/<itemref\b[^>]*>/g)]
    .map((m) => attr(m[0], "idref"))
    .filter((x): x is string => Boolean(x));

  // A nav/ncx file gives nicer chapter titles than the XHTML <title> tags.
  const titleByHref = readToc(files, names, read, base);

  const pieces: Piece[] = [];
  let ordinal = 0;

  for (const idref of spine) {
    const href = hrefById.get(idref);
    if (!href) continue;
    const full = resolve(base, href);
    const raw = files[full] ? read(full) : undefined;
    if (!raw) continue;

    const text = htmlToText(raw);
    if (text.trim().length < 40) continue;

    ordinal++;
    const label =
      titleByHref.get(href.split("#")[0]) ??
      tag(raw, "title") ??
      firstHeading(raw) ??
      `Section ${ordinal}`;

    pieces.push({ text, label, locator: { chapter: label } });
  }

  if (!pieces.length) throw new Error("EPUB parsed but contained no readable text.");
  return { pieces, meta };
}

function readToc(
  files: Record<string, Uint8Array>,
  names: string[],
  read: (n: string) => string,
  base: string
): Map<string, string> {
  const out = new Map<string, string>();
  const navName =
    names.find((n) => n.toLowerCase().endsWith("nav.xhtml")) ??
    names.find((n) => n.toLowerCase().endsWith("toc.ncx"));
  if (!navName || !files[navName]) return out;

  const nav = read(navName);
  if (navName.endsWith(".ncx")) {
    for (const m of nav.matchAll(/<navPoint[\s\S]*?<\/navPoint>/g)) {
      const label = tag(m[0], "text");
      const src = /<content\b[^>]*src="([^"]+)"/.exec(m[0])?.[1];
      if (label && src) out.set(strip(src.split("#")[0], base), label);
    }
  } else {
    for (const m of nav.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const label = decode(m[2].replace(/<[^>]+>/g, "").trim());
      if (label) out.set(strip(m[1].split("#")[0], base), label);
    }
  }
  return out;
}

function strip(href: string, base: string): string {
  return href.startsWith(base) ? href.slice(base.length) : href;
}

function resolve(base: string, href: string): string {
  if (!base) return href;
  const joined = base + href;
  // Collapse ../ segments the lazy way; EPUB paths are shallow.
  const parts: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? decode(m[1].replace(/<[^>]+>/g, "").trim()) || undefined : undefined;
}

function attr(tagText: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tagText)?.[1];
}

function firstHeading(html: string): string | undefined {
  const m = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
  return m ? decode(m[1].replace(/<[^>]+>/g, "").trim()) || undefined : undefined;
}

export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, "\n\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}
