import type { Piece } from "../chunk";

export interface PdfParse {
  pieces: Piece[];
  /** 1-based pages with no extractable text — these are scans and need OCR. */
  scannedPages: number[];
  pageCount: number;
  meta: { title?: string; author?: string };
}

/** Below this, a page is assumed to be an image rather than text. Running
 *  headers and page numbers alone clear about 30 characters. */
const TEXT_THRESHOLD = 120;

export async function parsePdf(bytes: Buffer): Promise<PdfParse> {
  // The legacy build is the one that runs outside a browser.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
    // Worker threads buy nothing here and complain in Node.
    disableFontFace: true,
  }).promise;

  const pieces: Piece[] = [];
  const scannedPages: number[] = [];

  let meta: { title?: string; author?: string } = {};
  try {
    const info = (await doc.getMetadata()).info as { Title?: string; Author?: string };
    meta = { title: info?.Title || undefined, author: info?.Author || undefined };
  } catch {
    /* metadata is optional */
  }

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();

    const text = joinItems(content.items as TextItem[]);
    page.cleanup();

    if (text.trim().length < TEXT_THRESHOLD) {
      scannedPages.push(n);
      continue;
    }
    pieces.push({ text, label: `p. ${n}`, locator: { page: n } });
  }

  await doc.destroy();
  return { pieces, scannedPages, pageCount: doc.numPages, meta };
}

interface TextItem {
  str: string;
  hasEOL?: boolean;
  transform?: number[];
  height?: number;
}

/**
 * pdfjs hands back positioned fragments, not lines. Reassembling on the Y
 * coordinate keeps paragraphs intact, which is what the chunker splits on —
 * naive concatenation produces one wall of text and much worse chunk
 * boundaries.
 */
function joinItems(items: TextItem[]): string {
  const lines: { y: number; size: number; parts: string[] }[] = [];

  for (const item of items) {
    if (!item.str) {
      continue;
    }
    const y = item.transform ? Math.round(item.transform[5]) : 0;
    const size = item.height ?? (item.transform ? Math.abs(item.transform[3]) : 0);
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - y) <= 2) {
      last.parts.push(item.str);
      last.size = Math.max(last.size, size);
    } else {
      lines.push({ y, size, parts: [item.str] });
    }
  }

  const rendered = lines
    .map((l) => ({ text: l.parts.join("").replace(/\s+/g, " ").trim(), size: l.size }))
    .filter((l) => l.text);

  // Body size is the most common one; anything meaningfully larger and short
  // is a heading. Emitting it as Markdown gives the chunker real boundaries to
  // split on, which keeps related sentences together and wastes fewer tokens
  // on half-topics.
  const bodySize = mode(rendered.map((l) => Math.round(l.size)));

  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(para.join(" "));
    para = [];
  };

  for (const line of rendered) {
    const isHeading =
      bodySize > 0 &&
      line.size >= bodySize * 1.15 &&
      line.text.length < 90 &&
      !/[.!?]$/.test(line.text);

    if (isHeading) {
      flush();
      out.push(`${line.size >= bodySize * 1.4 ? "##" : "###"} ${line.text}`);
      continue;
    }

    para.push(line.text.replace(/-$/, ""));
    const endsSentence = /[.!?؟:;"”)]$/.test(line.text);
    const short = line.text.length < 45;
    if (endsSentence && short) flush();
  }
  flush();

  return out.join("\n\n");
}

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) if (v > 0) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = 0;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) [best, bestN] = [v, n];
  return best;
}
