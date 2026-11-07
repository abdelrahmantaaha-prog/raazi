import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "./db";
import { blocks, normalise } from "./md-blocks";
import { MARKER_RE } from "./markers";
import { citationsFor, getBrief, type RenderedCitation } from "./brief";
import { dirOf } from "./dir";

/**
 * Entries and briefs as PDFs that read like a publication, not a print-out.
 *
 * The page is laid out here as its own small document — a title block, the
 * summary set apart, the body in a reading face, citations as numbered notes
 * collected at the end — and Microsoft Edge, which every Windows machine
 * has, turns it into the PDF headless. Chromium's print engine is the one
 * that gets Arabic shaping, right-to-left runs and page-margin boxes right,
 * which a PDF library drawing text itself does not.
 *
 * Nothing is fetched: the Arabic face is the Amiri subset Raazi already
 * ships, inlined, and the Latin face is one Windows has.
 */

const EDGE = [
  process.env.CORPUS_EDGE,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean) as string[];

export interface PrintDoc {
  /** The file's name, without the extension. */
  name: string;
  html: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fontFaces(): string {
  const dir = path.join(process.cwd(), "public", "fonts");
  const face = (file: string, weight: number, style: string) => {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return "";
    const data = fs.readFileSync(p).toString("base64");
    return `@font-face{font-family:"Amiri";font-weight:${weight};font-style:${style};src:url(data:font/woff2;base64,${data}) format("woff2");unicode-range:U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF;}`;
  };
  return [face("amiri-arabic-400.woff2", 400, "normal"), face("amiri-arabic-700.woff2", 700, "normal"), face("amiri-arabic-400i.woff2", 400, "italic")].join("\n");
}

/**
 * One run of text: bold, italics, links, and citation markers turned into
 * note numbers, numbered in the order they first appear in the document.
 */
function inline(text: string, notes: Map<number, number>, known: Set<number>): string {
  let s = esc(text);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  // Several markers in a row read as one bracket of numbers.
  s = s.replace(new RegExp(`(?:\\s*${MARKER_RE.source})+`, "g"), (run) => {
    const ids = [...run.matchAll(new RegExp(MARKER_RE.source, "g"))].map((m) => Number(m[1])).filter((id) => known.has(id));
    if (!ids.length) return "";
    const nums = [...new Set(ids.map((id) => {
      if (!notes.has(id)) notes.set(id, notes.size + 1);
      return notes.get(id)!;
    }))];
    return `<sup class="n">${nums.join(",")}</sup>`;
  });
  return s;
}

function body(md: string, notes: Map<number, number>, known: Set<number>): string {
  return blocks(normalise(md))
    .map((b) => {
      switch (b.kind) {
        case "h": {
          const level = Math.min(4, Math.max(2, b.level + 1));
          return `<h${level}>${inline(b.text, notes, known)}</h${level}>`;
        }
        case "p":
          return `<p>${inline(b.text, notes, known)}</p>`;
        case "quote":
          return `<blockquote>${inline(b.text, notes, known)}</blockquote>`;
        case "ul":
          return `<ul>${b.items.map((i) => `<li>${inline(i, notes, known)}</li>`).join("")}</ul>`;
        case "ol":
          return `<ol>${b.items.map((i) => `<li>${inline(i, notes, known)}</li>`).join("")}</ol>`;
      }
    })
    .join("\n");
}

function day(iso: string | null | undefined, rtl: boolean): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(rtl ? "ar-EG" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function notesSection(notes: Map<number, number>, cites: Map<number, RenderedCitation>, rtl: boolean): string {
  if (!notes.size) return "";
  const items = [...notes.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => {
      const c = cites.get(id)!;
      const where = [c.outlet, day(c.publishedAt, rtl)].filter(Boolean).join(" · ");
      const quote = c.quote.length > 320 ? `${c.quote.slice(0, 317).trimEnd()}…` : c.quote;
      const title = c.url ? `<a href="${esc(c.url)}">${esc(c.citation)}</a>` : esc(c.citation);
      return `<li><div class="cite">${title}${where ? ` <span class="where">${esc(where)}</span>` : ""}</div><div class="q">${esc(quote)}</div></li>`;
    });
  return `<section class="notes"><h2>${rtl ? "المصادر" : "Sources"}</h2><ol>${items.join("")}</ol></section>`;
}

function page(opts: { title: string; kicker: string; meta: string[]; lede?: string; bodyHtml: string; notesHtml: string; rtl: boolean }): string {
  const { rtl } = opts;
  return `<!doctype html>
<html lang="${rtl ? "ar" : "en"}" dir="${rtl ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<title>${esc(opts.title)}</title>
<style>
${fontFaces()}
@page {
  size: A4;
  margin: 22mm 20mm 24mm;
  @bottom-center { content: counter(page) " / " counter(pages); font: 8.5pt "Segoe UI", sans-serif; color: #8a8579; }
  @top-right { content: "${esc(opts.title.slice(0, 70))}"; font: 8pt "Segoe UI", sans-serif; color: #a8a295; }
}
@page :first { @top-right { content: none; } }
:root { --ink: #1f1d1a; --muted: #6f6a60; --rule: #ddd6c8; --accent: #7a4b2a; --tint: #f6f1e7; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: var(--ink); font: 10.8pt/1.62 Georgia, "Amiri", "Times New Roman", serif; ${rtl ? "font-size: 12.5pt; line-height: 1.8;" : ""} hyphens: auto; }
a { color: inherit; text-decoration: none; border-bottom: 0.5pt solid var(--rule); }
.kicker { font: 600 8pt/1 "Segoe UI", sans-serif; letter-spacing: ${rtl ? "0" : "0.16em"}; text-transform: uppercase; color: var(--accent); }
h1 { font-weight: 700; font-size: 25pt; line-height: 1.15; margin: 8pt 0 8pt; letter-spacing: -0.01em; }
.meta { font: 8.5pt/1.5 "Segoe UI", sans-serif; color: var(--muted); padding-bottom: 12pt; border-bottom: 1.2pt solid var(--ink); margin-bottom: 16pt; }
.meta span + span::before { content: "·"; margin: 0 6pt; color: var(--rule); }
.lede { background: var(--tint); border-${rtl ? "right" : "left"}: 3pt solid var(--accent); padding: 10pt 14pt; margin: 0 0 18pt; font-size: 11.6pt; line-height: 1.55; }
h2 { font-size: 14pt; margin: 20pt 0 6pt; padding-top: 6pt; border-top: 0.5pt solid var(--rule); break-after: avoid; }
h3 { font-size: 12pt; margin: 14pt 0 4pt; color: var(--accent); break-after: avoid; }
h4 { font-size: 11pt; margin: 10pt 0 2pt; font-style: italic; break-after: avoid; }
p { margin: 0 0 8pt; orphans: 3; widows: 3; text-align: justify; }
ul, ol { margin: 0 0 8pt; padding-${rtl ? "right" : "left"}: 16pt; }
li { margin-bottom: 3pt; }
blockquote { margin: 8pt 0 10pt; padding: 0 14pt; border-${rtl ? "right" : "left"}: 1.5pt solid var(--rule); color: #3d3a35; font-style: italic; }
sup.n { font: 600 6.8pt "Segoe UI", sans-serif; color: var(--accent); margin: 0 1pt; vertical-align: super; line-height: 0; }
.notes { margin-top: 24pt; break-before: auto; }
.notes h2 { font: 600 9pt "Segoe UI", sans-serif; letter-spacing: ${rtl ? "0" : "0.14em"}; text-transform: uppercase; color: var(--accent); border-top: 1.2pt solid var(--ink); padding-top: 8pt; }
.notes ol { font-size: 8.6pt; line-height: 1.45; padding-${rtl ? "right" : "left"}: 18pt; }
.notes li { margin-bottom: 6pt; break-inside: avoid; }
.notes li::marker { font: 600 8pt "Segoe UI", sans-serif; color: var(--accent); }
.notes .cite { font-weight: 600; }
.notes .where { font: 7.8pt "Segoe UI", sans-serif; color: var(--muted); font-weight: 400; }
.notes .q { color: var(--muted); font-style: italic; }
.foot { margin-top: 18pt; font: 7.5pt "Segoe UI", sans-serif; color: #a8a295; }
</style>
</head>
<body>
<div class="kicker">${esc(opts.kicker)}</div>
<h1>${esc(opts.title)}</h1>
<div class="meta">${opts.meta.filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join("")}</div>
${opts.lede ? `<div class="lede">${opts.lede}</div>` : ""}
${opts.bodyHtml}
${opts.notesHtml}
</body>
</html>`;
}

/** An entry: its name, what kind of thing it is, the summary, the body and its sources. */
export function entryDoc(entityId: number): PrintDoc | null {
  const e = db().prepare("SELECT id, canonical_name, type FROM entities WHERE id=?").get(entityId) as { id: number; canonical_name: string; type: string } | undefined;
  const entry = db().prepare("SELECT summary, body_md, updated_at FROM entries WHERE entity_id=?").get(entityId) as { summary: string | null; body_md: string; updated_at: string } | undefined;
  if (!e || !entry) return null;
  const all = `${entry.summary ?? ""}\n\n${entry.body_md}`;
  const rtl = dirOf(`${e.canonical_name} ${entry.body_md}`) === "rtl";
  const cites = new Map(citationsFor(all).map((c) => [c.id, c]));
  const known = new Set(cites.keys());
  const notes = new Map<number, number>();
  const lede = entry.summary ? inline(entry.summary, notes, known) : undefined;
  const bodyHtml = body(entry.body_md, notes, known);
  const sources = new Set([...notes.keys()].map((id) => cites.get(id)!.sourceId)).size;
  return {
    name: e.canonical_name,
    html: page({
      title: e.canonical_name,
      kicker: rtl ? "مدخل · Raazi" : `Raazi · ${e.type}`,
      meta: [
        rtl ? `حُدِّث ${day(entry.updated_at, rtl)}` : `Updated ${day(entry.updated_at, rtl)}`,
        sources ? (rtl ? `${sources} مصدرًا` : `${sources} source${sources === 1 ? "" : "s"}`) : "",
        notes.size ? (rtl ? `${notes.size} استشهادًا` : `${notes.size} citation${notes.size === 1 ? "" : "s"}`) : "",
      ],
      lede,
      bodyHtml,
      notesHtml: notesSection(notes, cites, rtl),
      rtl,
    }),
  };
}

/** A daily or weekly brief, by its day key. */
export function briefDoc(dayKey: string): PrintDoc | null {
  const b = getBrief(dayKey);
  if (!b || b.state !== "done" || !b.body_md?.trim()) return null;
  const rtl = dirOf(b.body_md) === "rtl";
  const cites = new Map(citationsFor(b.body_md).map((c) => [c.id, c]));
  const notes = new Map<number, number>();
  const bodyHtml = body(b.body_md, notes, new Set(cites.keys()));
  const weekly = b.kind === "week";
  const date = day(weekly ? b.window_to ?? b.day.replace(/^\D+/, "") : b.day, rtl);
  const title = weekly ? (rtl ? `الموجز الأسبوعي` : `The week`) : rtl ? `الموجز اليومي` : `Daily brief`;
  const covering = b.window_from && b.window_to ? `${rtl ? "يغطي" : "Covering"} ${day(b.window_from, rtl)} – ${day(b.window_to, rtl)}` : "";
  return {
    name: `${weekly ? "Weekly brief" : "Brief"} ${b.day}`,
    html: page({
      title: `${title} — ${date}`,
      kicker: "Raazi",
      meta: [covering, notes.size ? (rtl ? `${notes.size} استشهادًا` : `${notes.size} citations`) : ""],
      bodyHtml,
      notesHtml: notesSection(notes, cites, rtl),
      rtl,
    }),
  };
}

/** Print a page to PDF with Edge, headless. */
export async function toPdf(html: string): Promise<Buffer> {
  const exe = EDGE.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("Making a PDF needs Microsoft Edge or Google Chrome on this machine.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-pdf-"));
  const src = path.join(dir, "doc.html");
  const out = path.join(dir, "doc.pdf");
  fs.writeFileSync(src, html, "utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        exe,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${path.join(dir, "profile")}`,
          "--no-pdf-header-footer",
          `--print-to-pdf=${out}`,
          `file:///${src.replace(/\\/g, "/")}`,
        ],
        { windowsHide: true }
      );
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Making the PDF took too long."));
      }, 60_000);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", () => {
        clearTimeout(timer);
        if (fs.existsSync(out) && fs.statSync(out).size > 0) resolve();
        else reject(new Error("The PDF could not be made."));
      });
    });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
