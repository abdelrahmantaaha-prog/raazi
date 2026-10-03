import { unzip } from "../unzip";
import type { Piece } from "../chunk";

/**
 * Word documents, spreadsheets and slide decks.
 *
 * The modern formats — .docx, .xlsx, .pptx, and their OpenDocument cousins
 * .odt, .ods, .odp — are zip files of XML, and the text is in the XML. So they
 * are read here with the zip reader and a few patterns, no converter and no
 * dependency. The old binary formats (.doc, .xls, .ppt, before 2007) are a
 * different animal entirely and are not read: save them in the new format.
 *
 * What comes out is the text, in order, with the structure that matters for
 * reading — headings as headings, a table as rows of cells, each sheet and
 * slide under its own label so a citation can say where it came from.
 */

export interface OfficeParse {
  pieces: Piece[];
  meta: { title?: string; author?: string };
  /** Said back to you when something was left out, such as rows past the cap. */
  note?: string;
}

export const OFFICE_EXTENSIONS = [".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"];

/** Pictures read as a scanned page. Others (WebP, HEIC, TIFF…) want converting first. */
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg"];

/** A spreadsheet beyond this many rows per sheet is cut, and the note says so. */
const MAX_ROWS = 2000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Sections by the document's own headings only. The plain-text reader also
 * guesses headings from short capitalised lines, which suits a .txt and not a
 * Word file: a table row or a one-line paragraph would become a heading.
 */
function byHeadings(lines: string[]): Piece[] {
  const pieces: Piece[] = [];
  let label = "";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text) pieces.push({ text, label: label || "Text", locator: { chapter: label || undefined } });
    buf = [];
  };
  for (const line of lines) {
    const h = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (h) {
      flush();
      label = h[1];
      // The heading stays in the text too, so what it says can be cited.
      buf.push(h[1]);
    } else buf.push(line);
  }
  flush();
  return pieces;
}

function files(bytes: Buffer): Map<string, string> {
  const { files: list } = unzip(bytes, { maxTotalBytes: 512 * 1024 * 1024 });
  const out = new Map<string, string>();
  for (const f of list) if (/\.(xml|rels)$/i.test(f.path)) out.set(f.path, f.data.toString("utf8"));
  return out;
}

/** Title and author from the document's own properties, where it has them. */
function officeMeta(x: Map<string, string>): OfficeParse["meta"] {
  const core = x.get("docProps/core.xml") ?? x.get("meta.xml") ?? "";
  const pick = (tag: string) => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(core);
    const v = m ? xmlText(m[1]).trim() : "";
    return v || undefined;
  };
  return { title: pick("dc:title"), author: pick("dc:creator") ?? pick("meta:initial-creator") };
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

/** One Word paragraph's text: runs, tabs and line breaks. */
function wordRuns(p: string): string {
  let out = "";
  for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\/>/g)) {
    if (m[1] !== undefined) out += xmlText(m[1]);
    else if (m[0].startsWith("<w:tab")) out += "\t";
    else out += "\n";
  }
  return out;
}

export function parseDocx(bytes: Buffer): OfficeParse {
  const x = files(bytes);
  const doc = x.get("word/document.xml");
  if (!doc) throw new Error("This does not look like a Word document.");
  const body = doc.slice(doc.indexOf("<w:body"));
  const lines: string[] = [];

  // Tables and paragraphs in document order; a table's paragraphs are taken
  // with their table, as rows of cells, not again as loose paragraphs.
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const block = m[0];
    if (block.startsWith("<w:tbl")) {
      for (const row of block.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)) {
        const cells = [...row[0].matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map((c) =>
          [...c[0].matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) => wordRuns(p[0]).trim()).filter(Boolean).join(" ")
        );
        if (cells.some(Boolean)) lines.push(cells.join(" | "));
      }
      lines.push("");
      continue;
    }
    const text = wordRuns(block).trim();
    if (!text) {
      lines.push("");
      continue;
    }
    const style = /<w:pStyle w:val="([^"]+)"/.exec(block)?.[1] ?? "";
    const level = /^Title$/i.test(style) ? 1 : Number(/^Heading(\d)$/i.exec(style)?.[1] ?? 0);
    lines.push(level ? `${"#".repeat(Math.min(level, 6))} ${text}` : text);
    lines.push("");
  }
  return { pieces: byHeadings(lines), meta: officeMeta(x) };
}

export function parseOdt(bytes: Buffer): OfficeParse {
  const x = files(bytes);
  const content = x.get("content.xml");
  if (!content) throw new Error("This does not look like an OpenDocument text file.");
  const body = content.slice(content.indexOf("<office:body"));
  const lines: string[] = [];
  for (const m of body.matchAll(
    /<table:table\b[\s\S]*?<\/table:table>|<text:(h|p)\b([^>]*)>([\s\S]*?)<\/text:\1>|<text:(?:h|p)\b[^>]*\/>/g
  )) {
    if (m[0].startsWith("<table:table")) {
      // As in Word: a table is rows of cells, not a column of loose lines.
      for (const row of m[0].matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
        const cells = [...row[1].matchAll(/<table:table-cell\b[^>]*?(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)].map((c) =>
          [...(c[1] ?? "").matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)].map((p) => odfInline(p[1]).trim()).join(" ")
        );
        if (cells.some(Boolean)) lines.push(cells.join(" | "));
      }
      lines.push("");
      continue;
    }
    if (!m[1]) {
      lines.push("");
      continue;
    }
    const text = odfInline(m[3]).trim();
    if (!text) continue;
    const level = m[1] === "h" ? Number(/text:outline-level="(\d)"/.exec(m[2])?.[1] ?? 1) : 0;
    lines.push(level ? `${"#".repeat(level)} ${text}` : text, "");
  }
  return { pieces: byHeadings(lines), meta: officeMeta(x) };
}

/** OpenDocument inline text: spans unwrapped, its space, tab and break marks honoured. */
function odfInline(s: string): string {
  return xmlText(
    s
      .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_, n) => " ".repeat(Number(n ?? 1)))
      .replace(/<text:tab\s*\/>/g, "\t")
      .replace(/<text:line-break\s*\/>/g, "\n")
      .replace(/<text:note\b[\s\S]*?<\/text:note>/g, "")
      .replace(/<[^>]+>/g, "")
  );
}

// ---------------------------------------------------------------------------
// Spreadsheets
// ---------------------------------------------------------------------------

/** "C12" → column 2 (zero-based). */
function columnOf(ref: string): number {
  let n = 0;
  for (const c of /^[A-Z]+/.exec(ref)?.[0] ?? "A") n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

function sheetPiece(name: string, rows: string[][], cut: { rows: number }): Piece | null {
  const kept = rows.filter((r) => r.some((c) => c.trim()));
  if (!kept.length) return null;
  if (kept.length > MAX_ROWS) cut.rows += kept.length - MAX_ROWS;
  const text = kept
    .slice(0, MAX_ROWS)
    .map((r) => {
      let end = r.length;
      while (end > 0 && !r[end - 1].trim()) end--;
      return r.slice(0, end).map((c) => c.replace(/\s+/g, " ").trim()).join(" | ");
    })
    .join("\n");
  return { text: `Sheet: ${name}\n\n${text}`, locator: { chapter: name }, label: `Sheet: ${name}` };
}

export function parseXlsx(bytes: Buffer): OfficeParse {
  const x = files(bytes);
  const book = x.get("xl/workbook.xml");
  if (!book) throw new Error("This does not look like an Excel workbook.");

  const shared = [...(x.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1])).join("")
  );
  const rels = new Map(
    [...(x.get("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      /Id="([^"]+)"/.exec(m[0])?.[1] ?? "",
      (/Target="([^"]+)"/.exec(m[0])?.[1] ?? "").replace(/^\/?(xl\/)?/, "xl/"),
    ])
  );

  const cut = { rows: 0 };
  const pieces: Piece[] = [];
  for (const s of book.matchAll(/<sheet\b[^>]*>/g)) {
    const name = xmlText(/name="([^"]*)"/.exec(s[0])?.[1] ?? "Sheet");
    const rid = /r:id="([^"]+)"/.exec(s[0])?.[1] ?? "";
    const xml = x.get(rels.get(rid) ?? "");
    if (!xml) continue;
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row: string[] = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] ?? "";
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const type = /t="([^"]+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value = "";
        if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1])).join("");
        else if (type === "b" && v !== undefined) value = v === "1" ? "TRUE" : "FALSE";
        else if (v !== undefined) value = xmlText(v);
        const col = ref ? columnOf(ref) : row.length;
        while (row.length < col) row.push("");
        row[col] = value;
      }
      rows.push(row);
    }
    const piece = sheetPiece(name, rows, cut);
    if (piece) pieces.push(piece);
  }
  return {
    pieces,
    meta: officeMeta(x),
    note: cut.rows ? `${cut.rows} row(s) past the first ${MAX_ROWS} of a sheet were left out.` : undefined,
  };
}

export function parseOds(bytes: Buffer): OfficeParse {
  const x = files(bytes);
  const content = x.get("content.xml");
  if (!content) throw new Error("This does not look like an OpenDocument spreadsheet.");
  const cut = { rows: 0 };
  const pieces: Piece[] = [];
  for (const t of content.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)) {
    const name = xmlText(/table:name="([^"]*)"/.exec(t[1])?.[1] ?? "Sheet");
    const rows: string[][] = [];
    for (const r of t[2].matchAll(/<table:table-row\b([^>]*)>([\s\S]*?)<\/table:table-row>/g)) {
      const row: string[] = [];
      for (const c of r[2].matchAll(/<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
        const value = [...(c[2] ?? "").matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)].map((p) => odfInline(p[1])).join(" ");
        // An empty run of cells is written once with a repeat count, often in
        // the thousands to the sheet's edge; only a run with content is spelled out.
        const repeat = Number(/table:number-columns-repeated="(\d+)"/.exec(c[1])?.[1] ?? 1);
        for (let i = 0; i < (value ? Math.min(repeat, 100) : Math.min(repeat, 1)); i++) row.push(value);
      }
      const times = Number(/table:number-rows-repeated="(\d+)"/.exec(r[1])?.[1] ?? 1);
      if (row.some((c) => c.trim())) for (let i = 0; i < Math.min(times, 100); i++) rows.push(row);
      if (rows.length > MAX_ROWS * 2) break;
    }
    const piece = sheetPiece(name, rows, cut);
    if (piece) pieces.push(piece);
  }
  return {
    pieces,
    meta: officeMeta(x),
    note: cut.rows ? `${cut.rows} row(s) past the first ${MAX_ROWS} of a sheet were left out.` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

export function parsePptx(bytes: Buffer): OfficeParse {
  const x = files(bytes);
  const slides = [...x.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  if (!slides.length) throw new Error("This does not look like a PowerPoint deck.");
  const pieces: Piece[] = [];
  slides.forEach((k, i) => {
    const n = i + 1;
    const paragraphs = (xml: string) =>
      [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
        .map((p) => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => xmlText(t[1])).join(""))
        .filter((t) => t.trim());
    const body = paragraphs(x.get(k)!);
    // The speaker's notes are often where the substance is.
    const notes = paragraphs(x.get(k.replace("slides/slide", "notesSlides/notesSlide")) ?? "").filter(
      (t) => !/^\d+$/.test(t.trim())
    );
    const text = [...body, ...(notes.length ? ["", "Notes:", ...notes] : [])].join("\n").trim();
    if (text) pieces.push({ text, locator: { page: n }, label: `Slide ${n}` });
  });
  return { pieces, meta: officeMeta(x) };
}

export function parseOdp(bytes: Buffer): OfficeParse {
  const x = files(bytes);
  const content = x.get("content.xml");
  if (!content) throw new Error("This does not look like an OpenDocument presentation.");
  const pieces: Piece[] = [];
  let n = 0;
  for (const page of content.matchAll(/<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g)) {
    n++;
    const text = [...page[1].matchAll(/<text:(?:p|h)\b[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g)]
      .map((p) => odfInline(p[1]).trim())
      .filter(Boolean)
      .join("\n");
    if (text) pieces.push({ text, locator: { page: n }, label: `Slide ${n}` });
  }
  return { pieces, meta: officeMeta(x) };
}

/** Reads any of the six, by extension. */
export function parseOffice(ext: string, bytes: Buffer): OfficeParse {
  switch (ext.toLowerCase()) {
    case ".docx":
      return parseDocx(bytes);
    case ".odt":
      return parseOdt(bytes);
    case ".xlsx":
      return parseXlsx(bytes);
    case ".ods":
      return parseOds(bytes);
    case ".pptx":
      return parsePptx(bytes);
    case ".odp":
      return parseOdp(bytes);
    default:
      throw new Error(`Corpus cannot read ${ext} files.`);
  }
}
