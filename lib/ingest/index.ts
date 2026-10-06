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
import { IMAGE_EXTENSIONS, OFFICE_EXTENSIONS, parseOffice } from "./office";
import { patchMeta } from "../source-meta";
export { IMAGE_EXTENSIONS } from "./office";
import { PDFDocument } from "pdf-lib";
import { parseUrl } from "./web";
import { setSourceTags } from "../tags";
import { guessReadMode, queueExtractions } from "../reading";
import { clean, describeSaving } from "./clean";
import { canonicalUrl, normaliseLang, toPublishedAt } from "./meta";

/** Provenance a caller may know that the file itself does not carry. */
interface Provenance {
  /**
   * Join an existing run instead of opening one.
   *
   * A poll that brings in fourteen articles is one piece of work, not
   * fourteen: without this the Activity list becomes a wall of one-item runs
   * and pausing "the morning's feeds" means pausing them one at a time.
   */
  runId?: number;
  /** When it was published, ISO. A feed knows this; a pasted paragraph does not. */
  publishedAt?: string;
  /** The outlet or publisher, as you would cite it. */
  outlet?: string;
}

/** Pages per OCR call. Small enough that a failure costs little, large enough
 *  that a 400-page scan isn't 400 requests. */
const OCR_BATCH = 4;

/**
 * Files that would otherwise fall through to "text" and be read as gibberish:
 * refused, with what to do instead.
 */
const UNREADABLE: Record<string, string> = Object.fromEntries([
  ...[".doc", ".xls", ".ppt"].map((e) => [
    e,
    `Old ${e} files (from before 2007) cannot be read. Open it and save it as ${e}x, then add that.`,
  ]),
  ...[".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif"].map((e) => [
    e,
    "Corpus reads pictures saved as PNG or JPG. Save it as one of those, then add it.",
  ]),
  ...[".zip", ".rar", ".7z"].map((e) => [e, "An archive is added as a folder: Add source → Folder or zip."]),
  ...[".exe", ".dll", ".msi", ".iso", ".bin"].map((e) => [e, "That is a program or disk image, not a document."]),
]);

/** One picture as a one-page PDF, so the page reader can take it like a scan. */
async function imageToPdf(bytes: Buffer, ext: string): Promise<Buffer> {
  // What the picture is, by its first bytes rather than its name: a ".jpg"
  // that is really a PNG is common. And a fresh copy, because the PDF library
  // reads the whole memory block a Node buffer may share with other data,
  // and missed the start of a JPEG that sat partway into one (3 Oct 2026).
  const data = new Uint8Array(bytes);
  const isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
  const isJpg = data[0] === 0xff && data[1] === 0xd8;
  if (!isPng && !isJpg) throw new Error(`That ${ext} file is not a picture Corpus can read. Save it as PNG or JPG.`);
  const pdf = await PDFDocument.create();
  const image = isPng ? await pdf.embedPng(data) : await pdf.embedJpg(data);
  // Scaled to fit an A4-ish page at most, never enlarged.
  const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
  const w = image.width * scale;
  const h = image.height * scale;
  pdf.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
  return Buffer.from(await pdf.save());
}

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
  /** Null for a source that was held rather than queued — nothing is running. */
  runId: number | null;
  chunks: number;
  scannedPages: number;
  note: string;
}

export async function addFile(opts: Provenance & {
  filename: string;
  bytes: Buffer;
  title?: string;
  author?: string;
  budgetCap?: number | null;
  /** Chosen by you at add time. Left empty, the AI files it instead. */
  tags?: number[];
}): Promise<AddResult> {
  const givenExt = path.extname(opts.filename).toLowerCase();
  if (UNREADABLE[givenExt]) throw new Error(UNREADABLE[givenExt]);
  // A photograph of a page becomes a one-page scanned document, read by the
  // same page reader as a scanned PDF — so it is stored as that PDF.
  const photo = IMAGE_EXTENSIONS.includes(givenExt);
  const originalBytes = opts.bytes;
  if (photo) opts = { ...opts, bytes: await imageToPdf(opts.bytes, givenExt) };
  const office = OFFICE_EXTENSIONS.includes(givenExt);
  const kind: SourceKind = photo ? "pdf" : kindFor(opts.filename);
  const ext = photo ? ".pdf" : path.extname(opts.filename) || ".bin";
  const fallbackTitle = opts.title?.trim() || path.basename(opts.filename, path.extname(opts.filename));

  const sourceId = Number(
    db()
      .prepare("INSERT INTO sources (title, author, kind, status) VALUES (?, ?, ?, 'new')")
      .run(fallbackTitle, opts.author?.trim() || null, kind).lastInsertRowid
  );

  const stored = path.join(SOURCES_DIR, `${sourceId}${ext}`);
  await fs.promises.writeFile(stored, opts.bytes);
  db().prepare("UPDATE sources SET path=? WHERE id=?").run(stored, sourceId);
  // What the caller knows about provenance goes on first; the file's own
  // metadata fills only what is still empty.
  applyMeta(sourceId, { publishedAt: opts.publishedAt, outlet: opts.outlet });

  try {
    if (photo) {
      // Kept as it came, beside the PDF: the page reader sends the picture
      // itself, and a PNG cannot be had back out of the PDF it was put into.
      const original = path.join(SOURCES_DIR, `${sourceId}.photo${givenExt === ".jpeg" ? ".jpg" : givenExt}`);
      await fs.promises.writeFile(original, originalBytes);
      patchMeta(sourceId, { photo: true, original });
      return finish(sourceId, [], opts.budgetCap, opts.tags, {
        runId: opts.runId,
        scannedPages: [1],
        note: "A picture: its text is read off it like a scanned page.",
      });
    }
    if (office) {
      const parsed = parseOffice(givenExt, opts.bytes);
      applyMeta(sourceId, {
        title: opts.title?.trim() || parsed.meta.title || fallbackTitle,
        author: opts.author?.trim() || parsed.meta.author,
      });
      return finish(sourceId, parsed.pieces, opts.budgetCap, opts.tags, {
        runId: opts.runId,
        note: [`${parsed.pieces.length} section(s) read.`, parsed.note].filter(Boolean).join(" "),
      });
    }
    switch (kind) {
      case "pdf": {
        const parsed = await parsePdf(opts.bytes);
        applyMeta(sourceId, {
          title: opts.title?.trim() || parsed.meta.title || fallbackTitle,
          author: opts.author?.trim() || parsed.meta.author,
        });
        return finish(sourceId, parsed.pieces, opts.budgetCap, opts.tags, {
          runId: opts.runId,
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
          // A date you supplied outranks the manifest's, which is often the
          // e-book's own release rather than the work's.
          year: opts.publishedAt ? undefined : parsed.meta.year,
        });
        return finish(sourceId, parsed.pieces, opts.budgetCap, opts.tags, {
          runId: opts.runId,
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
          runId: opts.runId,
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

export async function addUrl(opts: Provenance & {
  url: string;
  title?: string;
  budgetCap?: number | null;
  /** Chosen by you at add time. Left empty, the AI files it instead. */
  tags?: number[];
  /**
   * What to record when the page itself cannot be read.
   *
   * A search feed links to a redirect or to an aggregator that renders in the
   * browser, and no amount of parsing recovers an article from either. The
   * feed still told us the headline, the outlet, the time and a summary, and
   * that is a real record — dated, attributed, searchable, and honest about
   * being a summary rather than the piece. Failing instead would leave a watch
   * on a phrase reporting nothing but errors.
   */
  fallbackText?: string;
  /**
   * Fetch and chunk it, then stop and wait to be asked.
   *
   * What a feed pulls in is not yet something you have chosen to read. Holding
   * costs nothing — the fetch and the chunking are local — and it is the whole
   * saving: extraction is the expensive stage, and an article you would have
   * dismissed by its first paragraph never reaches it. lib/triage.ts is what
   * releases one.
   */
  hold?: boolean;
}): Promise<AddResult> {
  const isYouTube = /youtu\.?be/.test(opts.url);
  const kind: SourceKind = isYouTube ? "media" : "url";

  // The canonical address is written before the fetch, so even a source that
  // fails to parse can be recognised if the same story is added again.
  const sourceId = Number(
    db()
      .prepare("INSERT INTO sources (title, kind, url, canonical_url, status) VALUES (?, ?, ?, ?, 'new')")
      .run(opts.title?.trim() || opts.url, kind, opts.url, canonicalUrl(opts.url)).lastInsertRowid
  );
  applyMeta(sourceId, { publishedAt: opts.publishedAt, outlet: opts.outlet });

  try {
    if (isYouTube) {
      const runId = opts.runId ?? createRun({
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

    let parsed: Awaited<ReturnType<typeof parseUrl>>;
    try {
      parsed = await parseUrl(opts.url);
    } catch (err) {
      // Nothing readable at the other end. Keep what the feed told us rather
      // than throwing the item away — but say plainly that this is the
      // summary, so nothing downstream mistakes it for the article.
      if (!opts.fallbackText?.trim()) throw err;
      const pieces = parseText(opts.fallbackText.trim());
      db()
        .prepare("UPDATE sources SET note=? WHERE id=?")
        .run(
          `The page could not be read (${(err as Error).message.slice(0, 120)}); this is the summary the feed carried.`,
          sourceId
        );
      return finish(sourceId, pieces, opts.budgetCap, opts.tags, {
        runId: opts.runId,
        hold: opts.hold,
        note: "Only the feed's own summary could be read; the page itself did not yield an article.",
      });
    }
    // What you supplied beats what the page declares.
    applyMeta(sourceId, {
      title: opts.title?.trim() || parsed.meta.title,
      author: parsed.meta.author,
      publisher: parsed.meta.publisher,
      outlet: opts.outlet?.trim() || parsed.meta.outlet,
      section: parsed.meta.section,
      publishedAt: opts.publishedAt?.trim() || parsed.meta.publishedAt,
      year: parsed.meta.year,
      lang: parsed.meta.lang,
      canonicalUrl: parsed.meta.canonicalUrl,
    });
    // The page's own picture, kept as an address. The inbox shows it and the
    // cover fetch uses it, so neither has to open the page a second time.
    if (parsed.meta.image) rememberImage(sourceId, parsed.meta.image);
    return finish(sourceId, parsed.pieces, opts.budgetCap, opts.tags, {
      runId: opts.runId,
      hold: opts.hold,
      note: "Article text extracted.",
    });
  } catch (err) {
    db()
      .prepare("UPDATE sources SET status='failed', note=? WHERE id=?")
      .run((err as Error).message.slice(0, 500), sourceId);
    throw err;
  }
}

export async function addPastedText(opts: Provenance & {
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
  applyMeta(sourceId, { publishedAt: opts.publishedAt, outlet: opts.outlet });
  const pieces = parseText(opts.text);
  return finish(sourceId, pieces, opts.budgetCap, opts.tags, {
    runId: opts.runId,
    note: `${pieces.length} section(s) parsed.`,
  });
}

/** Records where a source's picture lives, in the same meta the cover code reads. */
export function rememberImage(sourceId: number, image: string) {
  const row = db().prepare("SELECT meta_json FROM sources WHERE id=?").get(sourceId) as
    | { meta_json: string }
    | undefined;
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(row?.meta_json || "{}") as Record<string, unknown>;
  } catch {
    meta = {};
  }
  db().prepare("UPDATE sources SET meta_json=? WHERE id=?").run(JSON.stringify({ ...meta, image }), sourceId);
}

export interface SourceMeta {
  title?: string;
  author?: string;
  lang?: string;
  publisher?: string;
  outlet?: string;
  section?: string;
  dateline?: string;
  /** Any date string; stored as ISO, and `year` follows from it. */
  publishedAt?: string;
  year?: string;
  canonicalUrl?: string;
}

/**
 * Fills in what a source says about itself. A non-empty value replaces what
 * is on record and an empty one leaves it alone — a URL source is created
 * with its address as a placeholder title, and the page's title has to win.
 * Callers therefore apply what you typed *after* what the file declares, or
 * fold it in with precedence, as addUrl does.
 *
 * The language is normalised to a BCP-47 primary tag on the way in. The
 * column had "en", "En", "eng", "en-US" and "ar-EG" side by side, and any
 * grouping by language split on the spelling. The year follows from the
 * publication timestamp when there is one.
 */
export function applyMeta(sourceId: number, meta: SourceMeta) {
  const publishedAt = toPublishedAt(meta.publishedAt) ?? "";
  const year = publishedAt.slice(0, 4) || meta.year?.trim() || "";
  db()
    .prepare(
      `UPDATE sources SET
         title         = COALESCE(NULLIF(?, ''), title),
         author        = COALESCE(NULLIF(?, ''), author),
         lang          = COALESCE(NULLIF(?, ''), lang),
         publisher     = COALESCE(NULLIF(?, ''), publisher),
         outlet        = COALESCE(NULLIF(?, ''), outlet),
         section       = COALESCE(NULLIF(?, ''), section),
         dateline      = COALESCE(NULLIF(?, ''), dateline),
         published_at  = COALESCE(NULLIF(?, ''), published_at),
         year          = COALESCE(NULLIF(?, ''), year),
         canonical_url = COALESCE(NULLIF(?, ''), canonical_url)
       WHERE id = ?`
    )
    .run(
      meta.title ?? "",
      meta.author ?? "",
      normaliseLang(meta.lang) ?? "",
      meta.publisher ?? "",
      meta.outlet ?? "",
      meta.section ?? "",
      meta.dateline ?? "",
      publishedAt,
      year,
      meta.canonicalUrl ?? "",
      sourceId
    );
}

/** Writes the chunks, builds the run, queues the work, starts the worker. */
function finish(
  sourceId: number,
  rawPieces: Piece[],
  budgetCap: number | null | undefined,
  tags: number[] | undefined,
  extra: { scannedPages?: number[]; note: string; runId?: number; hold?: boolean }
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

  if (extra.hold) {
    const held = tx(() => {
      const chunkIds = pieces.length ? writeChunks(sourceId, pieces) : [];
      db()
        .prepare("UPDATE sources SET status='chunked', triage='held', read_mode='eager' WHERE id=?")
        .run(sourceId);
      if (tags?.length) setSourceTags(sourceId, tags, "user");
      return chunkIds.length;
    });
    return {
      sourceId,
      runId: null,
      chunks: held,
      scannedPages: 0,
      note: [extra.note, saving, "Waiting in the inbox for you to say whether it is worth reading."]
        .filter(Boolean)
        .join(" "),
    };
  }

  const runId =
    extra.runId ??
    createRun({
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
  // A shipping paper is read whole for its shipment before names are
  // reconciled, so the parties it adds are reconciled with the rest.
  if (sourceId) enqueue(runId, [{ kind: "shipment" as const, payload: { sourceId } }]);
  // The source id lets the resolve pass compare only what this ingest touched
  // rather than every entity of the type against every other.
  enqueue(
    runId,
    ENTITY_TYPES.map((type) => ({
      kind: "resolve" as const,
      payload: sourceId ? { type, sourceId } : { type },
    }))
  );
  // The name sweep runs after resolution and before entries are written: it
  // needs the alias lists to have settled, and the entries need its findings.
  if (sourceId) enqueue(runId, [{ kind: "sweep" as const, payload: { sourceId } }]);
  // Then give the quotes that cannot stand alone their bearings back, before
  // anything is written from them.
  if (sourceId) enqueue(runId, [{ kind: "plan_context" as const, payload: { sourceId } }]);
  enqueue(runId, [{ kind: "plan_entries" as const, payload: {} }]);
}

