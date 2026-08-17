import fs from "node:fs";
import path from "node:path";
import { SOURCES_DIR, db, tx } from "../db";
import { getConfig } from "../config";
import { createRun, enqueue } from "../queue";
import { writeChunks } from "../pipeline/ocr";
import { kickWorker } from "../worker";
import { ENTITY_TYPES, type SourceKind } from "../types";
import type { Piece } from "../chunk";
import { parseText } from "./text";
import { parsePdf } from "./pdf";
import { parseEpub } from "./epub";
import { parseUrl } from "./web";
import { setSourceTags } from "../tags";
import { guessReadMode, queueExtractions } from "../reading";
import { clean, describeSaving } from "./clean";

/** Pages per OCR call. Small enough that a failure costs little, large enough
 *  that a 400-page scan isn't 400 requests. */
const OCR_BATCH = 4;

export function kindFor(filename: string): SourceKind {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".epub") return "epub";
  if ([".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac", ".mp4", ".webm", ".mov"].includes(ext)) {
    return "media";
  }
  return "text";
}

export interface AddResult {
  sourceId: number;
  runId: number;
  chunks: number;
  scannedPages: number;
  note: string;
}

export async function addFile(opts: {
  filename: string;
  bytes: Buffer;
  title?: string;
  author?: string;
  budgetCap?: number | null;
  /** Chosen by you at add time. Left empty, the AI files it instead. */
  tags?: number[];
}): Promise<AddResult> {
  const kind = kindFor(opts.filename);
  const ext = path.extname(opts.filename) || ".bin";
  const fallbackTitle = opts.title?.trim() || path.basename(opts.filename, ext);

  const sourceId = Number(
    db()
      .prepare("INSERT INTO sources (title, author, kind, status) VALUES (?, ?, ?, 'new')")
      .run(fallbackTitle, opts.author?.trim() || null, kind).lastInsertRowid
  );

  const stored = path.join(SOURCES_DIR, `${sourceId}${ext}`);
  await fs.promises.writeFile(stored, opts.bytes);
  db().prepare("UPDATE sources SET path=? WHERE id=?").run(stored, sourceId);

  try {
    switch (kind) {
      case "pdf": {
        const parsed = await parsePdf(opts.bytes);
        applyMeta(sourceId, {
          title: opts.title?.trim() || parsed.meta.title || fallbackTitle,
          author: opts.author?.trim() || parsed.meta.author,
        });
        return finish(sourceId, parsed.pieces, opts.budgetCap, opts.tags, {
          scannedPages: parsed.scannedPages,
          note:
            parsed.scannedPages.length > 0
              ? `${parsed.pieces.length} text page(s) read for free; ${parsed.scannedPages.length} scanned page(s) queued for OCR.`
              : `${parsed.pieces.length} page(s) of embedded text — no OCR needed.`,
        });
      }
      case "epub": {
        const parsed = parseEpub(opts.bytes);
        applyMeta(sourceId, {
          title: opts.title?.trim() || parsed.meta.title || fallbackTitle,
          author: opts.author?.trim() || parsed.meta.author,
          lang: parsed.meta.lang,
          publisher: parsed.meta.publisher,
          year: parsed.meta.year,
        });
        return finish(sourceId, parsed.pieces, opts.budgetCap, opts.tags, {
          note: `${parsed.pieces.length} chapter(s) parsed.`,
        });
      }
      case "media": {
        const runId = createRun({
          sourceId,
          kind: "ingest",
          label: fallbackTitle,
          budgetCap: opts.budgetCap ?? getConfig().defaultBudget,
        });
        tx(() => {
          enqueue(runId, [{ kind: "transcribe", payload: { sourceId } }]);
          // Media has no text until it is transcribed, so filing waits its turn.
          if (opts.tags?.length) setSourceTags(sourceId, opts.tags, "user");
          else enqueue(runId, [{ kind: "tag", payload: { sourceId } }]);
          appendTail(runId, sourceId);
          db().prepare("UPDATE sources SET status='extracting' WHERE id=?").run(sourceId);
        });
        kickWorker();
        return {
          sourceId,
          runId,
          chunks: 0,
          scannedPages: 0,
          note: "Queued for transcription; chunks appear once the transcript is back.",
        };
      }
      default: {
        const pieces = parseText(opts.bytes.toString("utf8"));
        return finish(sourceId, pieces, opts.budgetCap, opts.tags, {
          note: `${pieces.length} section(s) parsed.`,
        });
      }
    }
  } catch (err) {
    db()
      .prepare("UPDATE sources SET status='failed', note=? WHERE id=?")
      .run((err as Error).message.slice(0, 500), sourceId);
    throw err;
  }
}

export async function addUrl(opts: {
  url: string;
  title?: string;
  budgetCap?: number | null;
  /** Chosen by you at add time. Left empty, the AI files it instead. */
  tags?: number[];
}): Promise<AddResult> {
  const isYouTube = /youtu\.?be/.test(opts.url);
  const kind: SourceKind = isYouTube ? "media" : "url";

  const sourceId = Number(
    db()
      .prepare("INSERT INTO sources (title, kind, url, status) VALUES (?, ?, ?, 'new')")
      .run(opts.title?.trim() || opts.url, kind, opts.url).lastInsertRowid
  );

  try {
    if (isYouTube) {
      const runId = createRun({
        sourceId,
        kind: "ingest",
        label: opts.title?.trim() || opts.url,
        budgetCap: opts.budgetCap ?? getConfig().defaultBudget,
      });
      tx(() => {
        enqueue(runId, [{ kind: "transcribe", payload: { sourceId } }]);
        // Nothing to judge the topic from until the transcript is back.
        if (opts.tags?.length) setSourceTags(sourceId, opts.tags, "user");
        else enqueue(runId, [{ kind: "tag", payload: { sourceId } }]);
        appendTail(runId, sourceId);
        db().prepare("UPDATE sources SET status='extracting' WHERE id=?").run(sourceId);
      });
      kickWorker();
      return {
        sourceId,
        runId,
        chunks: 0,
        scannedPages: 0,
        note: "Queued for transcription straight from YouTube.",
      };
    }

    const parsed = await parseUrl(opts.url);
    applyMeta(sourceId, {
      title: opts.title?.trim() || parsed.meta.title,
      author: parsed.meta.author,
      publisher: parsed.meta.publisher,
      year: parsed.meta.year,
      lang: parsed.meta.lang,
    });
    return finish(sourceId, parsed.pieces, opts.budgetCap, opts.tags, {
      note: "Article text extracted.",
    });
  } catch (err) {
    db()
      .prepare("UPDATE sources SET status='failed', note=? WHERE id=?")
      .run((err as Error).message.slice(0, 500), sourceId);
    throw err;
  }
}

export async function addPastedText(opts: {
  title: string;
  author?: string;
  text: string;
  budgetCap?: number | null;
  /** Chosen by you at add time. Left empty, the AI files it instead. */
  tags?: number[];
}): Promise<AddResult> {
  const sourceId = Number(
    db()
      .prepare("INSERT INTO sources (title, author, kind, status) VALUES (?, ?, 'text', 'new')")
      .run(opts.title.trim(), opts.author?.trim() || null).lastInsertRowid
  );
  const pieces = parseText(opts.text);
  return finish(sourceId, pieces, opts.budgetCap, opts.tags, { note: `${pieces.length} section(s) parsed.` });
}

function applyMeta(
  sourceId: number,
  meta: { title?: string; author?: string; lang?: string; publisher?: string; year?: string }
) {
  db()
    .prepare(
      `UPDATE sources SET
         title     = COALESCE(NULLIF(?, ''), title),
         author    = COALESCE(NULLIF(?, ''), author),
         lang      = COALESCE(NULLIF(?, ''), lang),
         publisher = COALESCE(NULLIF(?, ''), publisher),
         year      = COALESCE(NULLIF(?, ''), year)
       WHERE id = ?`
    )
    .run(meta.title ?? "", meta.author ?? "", meta.lang ?? "", meta.publisher ?? "", meta.year ?? "", sourceId);
}

/** Writes the chunks, builds the run, queues the work, starts the worker. */
function finish(
  sourceId: number,
  rawPieces: Piece[],
  budgetCap: number | null | undefined,
  tags: number[] | undefined,
  extra: { scannedPages?: number[]; note: string }
): AddResult {
  const scanned = extra.scannedPages ?? [];

  // Strip endnotes, bibliographies and page furniture before anything is
  // chunked. This is local and free; every character removed here is a token
  // never spent, on every extraction call that would have covered it.
  const cleaned = clean(rawPieces);
  const saving = describeSaving(cleaned.dropped);
  const pieces = cleaned.pieces;

  if (pieces.length === 0 && scanned.length === 0) {
    throw new Error("Nothing readable was found in that source.");
  }

  const title = (
    db().prepare("SELECT title FROM sources WHERE id=?").get(sourceId) as { title: string }
  ).title;

  const runId = createRun({
    sourceId,
    kind: "ingest",
    label: title,
    budgetCap: budgetCap ?? getConfig().defaultBudget,
  });

  const result = tx(() => {
    const chunkIds = pieces.length ? writeChunks(sourceId, pieces) : [];

    // The read-along decision is made now, from the size of the thing, and
    // written down — so it cannot drift later when OCR adds pages and changes
    // the count that the guess was based on.
    const mode = guessReadMode({ chunks: chunkIds.length + scanned.length });
    db().prepare("UPDATE sources SET read_mode=? WHERE id=? AND read_mode IS NULL").run(mode, sourceId);

    // Filing comes first: it is one cheap call, and knowing the topic up front
    // means the source is already on the right shelf while it is being read.
    if (!tags?.length) {
      enqueue(runId, [{ kind: "tag" as const, payload: { sourceId } }]);
    } else {
      setSourceTags(sourceId, tags, "user");
    }

    const queued = queueExtractions(runId, sourceId, chunkIds);

    // Scanned pages still become OCR jobs whatever the mode: OCR is how the
    // text comes to exist at all, and you cannot read a page that has not been
    // transcribed. Only the *extraction* of those pages waits for you.
    for (let i = 0; i < scanned.length; i += OCR_BATCH) {
      const batch = scanned.slice(i, i + OCR_BATCH);
      enqueue(runId, [
        {
          kind: "ocr" as const,
          payload: { sourceId, fromPage: batch[0], toPage: batch[batch.length - 1] },
        },
      ]);
    }

    // Nothing to reconcile or write up until something has been extracted.
    if (queued > 0 || scanned.length > 0) appendTail(runId, sourceId);
    db().prepare("UPDATE sources SET status='extracting' WHERE id=?").run(sourceId);
    return { chunks: chunkIds.length, mode };
  });

  kickWorker();
  return {
    sourceId,
    runId,
    chunks: result.chunks,
    scannedPages: scanned.length,
    note: [
      extra.note,
      saving,
      result.mode === "along"
        ? "Long enough to read along with: Corpus reads each passage as you get to it, rather than the whole thing up front."
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/**
 * Every ingest ends the same way: reconcile duplicate entities across the whole
 * pedia, then decide which entities have earned an entry. These run last
 * because both need the full mention set to be in place.
 */
function appendTail(runId: number, sourceId?: number) {
  enqueue(
    runId,
    ENTITY_TYPES.map((type) => ({ kind: "resolve" as const, payload: { type } }))
  );
  // The name sweep runs after resolution and before entries are written: it
  // needs the alias lists to have settled, and the entries need its findings.
  if (sourceId) enqueue(runId, [{ kind: "sweep" as const, payload: { sourceId } }]);
  // Then give the quotes that cannot stand alone their bearings back, before
  // anything is written from them.
  if (sourceId) enqueue(runId, [{ kind: "plan_context" as const, payload: { sourceId } }]);
  enqueue(runId, [{ kind: "plan_entries" as const, payload: {} }]);
}

