import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { db, tx } from "../db";
import { generateText } from "../ai/client";
import { finishTask } from "../queue";
import { queueExtractions } from "../reading";
import type { Task } from "../types";
import { buildChunks, type Piece } from "../chunk";

/**
 * Scanned pages only. `lib/ingest/pdf.ts` extracts embedded text for free and
 * routes here only the pages that came back empty, so a born-digital book
 * costs nothing to read and a scanned one pays only for the pages that need it.
 *
 * Gemini reads PDF pages as images natively, so rather than rasterising locally
 * (which would mean a canvas native dependency) we slice the requested pages
 * into a small PDF with pdf-lib and send that.
 */

const SYSTEM = `You are transcribing scanned pages of a book.

Return the text of the pages exactly as printed, in reading order. Preserve
paragraph breaks. Do not translate, summarise, correct, or comment. If a page is
blank or unreadable, output nothing for it.

Begin each page with a line containing only <<<PAGE n>>>, using the page number
given to you.`;

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
  const slice = await PDFDocument.create();
  const indices: number[] = [];
  for (let p = fromPage; p <= toPage && p <= src.getPageCount(); p++) indices.push(p - 1);
  const copied = await slice.copyPages(src, indices);
  copied.forEach((p) => slice.addPage(p));
  const sliceBytes = await slice.save();

  const { data: text, usage } = await generateText({
    need: "vision",
    // Transcribing is reading, so it follows the reading stage's routing: with
    // reading on Claude, a scanned page goes to Claude first rather than
    // waiting on a Gemini key that may not be there.
    stage: "extract",
    system: SYSTEM,
    temperature: 0,
    parts: [
      `Transcribe pages ${fromPage} to ${toPage} of "${source.title}". Number them from ${fromPage}.`,
      { inlineData: { mimeType: "application/pdf", data: Buffer.from(sliceBytes).toString("base64") } },
    ],
  });

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
