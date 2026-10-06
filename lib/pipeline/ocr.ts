import fs from "node:fs";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, type PDFPage } from "pdf-lib";
import { db, tx } from "../db";
import { generateText, type Part } from "../ai/client";
import { getConfig } from "../config";
import { finishTask } from "../queue";
import { queueExtractions } from "../reading";
import { readMeta } from "../source-meta";
import type { Task } from "../types";
import { buildChunks, type Piece } from "../chunk";
import { languageName } from "./extract";

/**
 * Scanned pages only. `lib/ingest/pdf.ts` extracts embedded text for free and
 * routes here only the pages that came back empty, so a born-digital book
 * costs nothing to read and a scanned one pays only for the pages that need it.
 *
 * Gemini reads PDF pages as images natively, so rather than rasterising locally
 * (which would mean a canvas native dependency) we slice the requested pages
 * into a small PDF with pdf-lib and send that.
 */

const UNREADABLE = "<<<UNREADABLE>>>";

const SYSTEM = `You are transcribing scanned pages of a document.

Return the text of the pages exactly as printed, in reading order. Preserve
paragraph breaks. Do not translate, summarise, correct, or comment. If a page is
blank, output nothing for it.

Begin each page with a line containing only <<<PAGE n>>>, using the page number
given to you. If you cannot open or see the pages at all, output only
${UNREADABLE} followed by the reason, and nothing else.`;

/**
 * For a photograph. The book transcriber's "output nothing for a blank page"
 * meant a picture of crates on an airport apron, with no printed text, came
 * back as nothing — while the dolly code and the airline on the tail fin were
 * exactly what the investigation needed. A photo is described as well as read.
 */
function photoSystem(lang: string): string {
  return `You are reading a photograph a journalist added to an investigation, so that
what it shows can be searched and cited later.

Write two parts, each starting with its marker line, and nothing else:

<<<TEXT>>>
Every piece of legible text in the picture, exactly as written: labels, signs,
documents, screens, stamps, markings on vehicles, crates, containers and
aircraft, registration and tail numbers, pallet and container codes. One item
per line, with where it appears in square brackets, e.g. "CP28 [painted on the
cargo dolly]". Do not translate the text itself. Write "none" if nothing is
legible.

<<<DESCRIPTION>>>
What the photograph shows, plainly and factually, in ${lang}: the setting; the
objects, vehicles, aircraft or vessels and their visible markings or livery;
how goods are packed and handled; how many people and what they are doing; the
time of day if it is evident. Name a company, airline or brand only when its
name or unmistakable logo is visible, and say what shows it. Do not guess what
is inside closed packaging, where the photo was taken, or who anyone is, beyond
what can be seen.

If you cannot open or see the picture, output only ${UNREADABLE} followed by the
reason.`;
}

export async function handleOcr(task: Task): Promise<void> {
  const { sourceId, fromPage, toPage } = JSON.parse(task.payload_json) as {
    sourceId: number;
    fromPage: number;
    toPage: number;
  };

  const source = db().prepare("SELECT * FROM sources WHERE id=?").get(sourceId) as
    | { id: number; path: string | null; title: string }
    | undefined;
  if (!source?.path || !fs.existsSync(source.path)) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Source file is missing.");
    return;
  }

  const bytes = await fs.promises.readFile(source.path);
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const indices: number[] = [];
  for (let p = fromPage; p <= toPage && p <= src.getPageCount(); p++) indices.push(p - 1);

  // Pages that are each one photograph go as the photograph itself. Claude on
  // the plan opens a picture natively but a PDF only with tools this machine
  // may not have; sent as PDFs, the pictures came back as "I cannot locate the
  // file", and that apology was filed as the page's text (5 Oct 2026).
  const images = pageImages(src, indices);
  const photo = isPhoto(sourceId, source.title, src, images);

  const meta = readMeta(sourceId);
  const original =
    typeof meta.original === "string" && indices.length === 1 && fs.existsSync(meta.original) ? meta.original : null;

  let attachments: Part[];
  if (original) {
    const mimeType = original.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    attachments = [{ inlineData: { mimeType, data: (await fs.promises.readFile(original)).toString("base64") } }];
  } else if (images) {
    attachments = images.map((jpg) => ({ inlineData: { mimeType: "image/jpeg", data: jpg.toString("base64") } }));
  } else {
    const slice = await PDFDocument.create();
    const copied = await slice.copyPages(src, indices);
    copied.forEach((p) => slice.addPage(p));
    attachments = [{ inlineData: { mimeType: "application/pdf", data: Buffer.from(await slice.save()).toString("base64") } }];
  }

  const ask = photo
    ? "Read the attached photograph."
    : images && images.length > 1
      ? `Transcribe the attached page images, in order. They are pages ${fromPage} to ${toPage}; number them from ${fromPage}.`
      : `Transcribe the attached pages. They are pages ${fromPage} to ${toPage}; number them from ${fromPage}.`;

  const { data: text, usage } = await generateText({
    need: "vision",
    // Transcribing is reading, so it follows the reading stage's routing: with
    // reading on Claude, a scanned page goes to Claude first rather than
    // waiting on a Gemini key that may not be there.
    stage: "extract",
    system: photo ? photoSystem(languageName(getConfig().entryLanguage)) : SYSTEM,
    // A photograph is evidence and there are few of them: the reading model,
    // chosen for thousands of passages, read a crate made of board as a crate
    // full of it and missed the code painted on the dolly. The writer reads them.
    ...(photo ? { claudeModel: strongClaude() } : {}),
    temperature: 0,
    parts: [ask, ...attachments],
  });

  // Whatever came back must be what was asked for. Anything else — an apology,
  // a question about which file was meant — is a failed read, and fails
  // loudly rather than becoming the source's text.
  const refused = text.indexOf(UNREADABLE);
  if (refused >= 0) {
    throw new Error(`Could not read the picture: ${text.slice(refused + UNREADABLE.length).trim().slice(0, 300) || "no reason given"}`);
  }

  if (photo) {
    const piece = photoPiece(text, fromPage);
    if (!piece) throw new Error(`The answer was not a reading of the picture: ${text.trim().slice(0, 200)}`);
    tx(() => {
      const chunkIds = writeChunks(sourceId, [piece]);
      const queued = queueExtractions(task.run_id, sourceId, chunkIds);
      finishTask(task.id, task.run_id, usage, "done", `Read the photograph${queued ? "" : "; extraction waits for you to read it"}.`);
    });
    return;
  }

  if (!/<<<PAGE\s+\d+>>>/.test(text) && text.trim()) {
    throw new Error(`The answer was not a transcription: ${text.trim().slice(0, 200)}`);
  }
  const pages = splitPages(text, fromPage);
  const pieces: Piece[] = pages
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({ text: p.text, locator: { page: p.page }, label: `p. ${p.page}` }));

  if (pieces.length === 0) {
    finishTask(task.id, task.run_id, usage, "skipped", "Pages appear blank.");
    return;
  }

  tx(() => {
    const chunkIds = writeChunks(sourceId, pieces);
    // On a read-along source this queues nothing: the pages now exist and are
    // readable, and extraction waits until you have read them.
    const queued = queueExtractions(task.run_id, sourceId, chunkIds);
    finishTask(
      task.id,
      task.run_id,
      usage,
      "done",
      `OCR'd ${pieces.length} page(s)${queued ? "" : "; extraction waits for you to read them"}.`
    );
  });
}

/**
 * The JPEG behind each page, when every page is exactly one JPEG and nothing
 * else — a photo added to Corpus, or most scans. Null when any page is not, and
 * the pages then go as a PDF slice.
 */
export function pageImages(doc: PDFDocument, indices: number[]): Buffer[] | null {
  const out: Buffer[] = [];
  for (const i of indices) {
    const jpg = soleJpeg(doc, doc.getPage(i));
    if (!jpg) return null;
    out.push(jpg);
  }
  return out.length ? out : null;
}

function soleJpeg(doc: PDFDocument, page: PDFPage): Buffer | null {
  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (!xobjects) return null;
  const images: PDFRawStream[] = [];
  for (const [, ref] of xobjects.entries()) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) return null;
    if (String(stream.dict.get(PDFName.of("Subtype"))) !== "/Image") return null;
    images.push(stream);
  }
  if (images.length !== 1) return null;
  const filter = String(images[0].dict.get(PDFName.of("Filter")) ?? "");
  // Only a plain JPEG is the picture byte for byte; a filter chain is not.
  if (filter !== "/DCTDecode" && filter !== "[ /DCTDecode ]") return null;
  return Buffer.from(images[0].contents);
}

/** A photograph rather than a scanned page: flagged when it was added, or,
 *  for one added before the flag, a lone picture named like a photo. */
function isPhoto(sourceId: number, title: string, doc: PDFDocument, images: Buffer[] | null): boolean {
  if (readMeta(sourceId).photo === true) return true;
  return (
    doc.getPageCount() === 1 &&
    images?.length === 1 &&
    /\b(img|image|photo|whatsapp|screenshot|dsc|pxl)\b|\.(jpe?g|png|heic|webp)$/i.test(title)
  );
}

/** The two parts of a photo reading, as one passage that says what each is. */
export function photoPiece(text: string, page: number): Piece | null {
  const m = /<<<TEXT>>>([\s\S]*?)<<<DESCRIPTION>>>([\s\S]*)/.exec(text);
  if (!m) return null;
  // A stray marker the model closed with, and a "none" left beside real items.
  const clean = (s: string) =>
    s
      .split("\n")
      .filter((line) => !/^\s*(<<<[^>]*>>>|>>>|<<<)\s*$/.test(line))
      .join("\n")
      .trim();
  const items = clean(m[1])
    .split("\n")
    .filter((line) => line.trim());
  const legible = (items.length > 1 ? items.filter((line) => !/^none\.?$/i.test(line.trim())) : items).join("\n");
  const described = clean(m[2]);
  if (!described) return null;
  const body = [
    /^none\.?$/i.test(legible) || !legible ? "Text in the photograph: none legible." : `Text in the photograph:\n${legible}`,
    // Said in the passage itself, so a quote taken from here is never
    // mistaken for words printed in the picture.
    `What the photograph shows (described by the AI that read it, not words in the picture):\n${described}`,
  ].join("\n\n");
  return { text: body, locator: { page }, label: "photo" };
}

/** The Claude that writes the entries: the strongest one this library uses. */
export function strongClaude(): string {
  const cfg = getConfig();
  return cfg.stageModels?.entry || "claude-opus-5-5";
}

function splitPages(text: string, firstPage: number): { page: number; text: string }[] {
  const parts = text.split(/<<<PAGE\s+(\d+)>>>/g);
  if (parts.length < 3) return [{ page: firstPage, text }];
  const out: { page: number; text: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    out.push({ page: Number(parts[i]), text: (parts[i + 1] ?? "").trim() });
  }
  return out;
}

/** Shared by every ingest path: pieces in, chunk rows out. Caller supplies the
 *  transaction. */
export function writeChunks(sourceId: number, pieces: Piece[]): number[] {
  const chunks = buildChunks(pieces);
  const startSeq =
    (db()
      .prepare("SELECT COALESCE(MAX(seq), -1) AS m FROM chunks WHERE source_id=?")
      .get(sourceId) as { m: number }).m + 1;

  const docStmt = db().prepare(
    "INSERT INTO documents (source_id, ordinal, label) VALUES (?, ?, ?)"
  );
  const chunkStmt = db().prepare(
    `INSERT INTO chunks (source_id, doc_id, seq, text, token_est, locator_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const docIds = new Map<string, number>();
  const ids: number[] = [];

  chunks.forEach((c, i) => {
    let docId = docIds.get(c.label);
    if (docId === undefined) {
      docId = Number(docStmt.run(sourceId, docIds.size, c.label).lastInsertRowid);
      docIds.set(c.label, docId);
    }
    ids.push(
      Number(
        chunkStmt.run(sourceId, docId, startSeq + i, c.text, c.tokenEst, JSON.stringify(c.locator))
          .lastInsertRowid
      )
    );
  });

  return ids;
}
