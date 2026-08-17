import fs from "node:fs";
import path from "node:path";
import { db, tx } from "../db";
import { client, generateText } from "../ai/client";
import { enqueue, finishTask } from "../queue";
import type { Task } from "../types";
import { writeChunks } from "./ocr";
import type { Piece } from "../chunk";

/**
 * Lectures, interviews, documentaries. YouTube links go straight to Gemini as a
 * fileData part — no yt-dlp, no ffmpeg, nothing to install. Local media is
 * uploaded through the Files API.
 *
 * The timecodes are the point: a citation to a two-hour interview is useless
 * unless it says where in the interview.
 */

const SYSTEM = `You are transcribing a recording for a research archive.

Transcribe what is said, verbatim, in the language spoken. Do not translate,
summarise, or clean up phrasing.

Start a new segment roughly every 60 seconds, or whenever the speaker changes.
Begin each segment with a line containing only <<<TIME hh:mm:ss>>> giving the
start of that segment. If speakers are identifiable, prefix their lines with a
name and a colon.`;

const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mp3",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

export async function handleTranscribe(task: Task): Promise<void> {
  const { sourceId } = JSON.parse(task.payload_json) as { sourceId: number };

  const source = db().prepare("SELECT * FROM sources WHERE id=?").get(sourceId) as
    | { id: number; path: string | null; url: string | null; title: string }
    | undefined;
  if (!source) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Source vanished.");
    return;
  }

  const already = db()
    .prepare("SELECT COUNT(*) AS n FROM chunks WHERE source_id=?")
    .get(sourceId) as { n: number };
  if (already.n > 0) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Already transcribed.");
    return;
  }

  let mediaPart:
    | { fileData: { fileUri: string; mimeType?: string } }
    | { inlineData: { mimeType: string; data: string } };

  if (source.url && /youtu\.?be/.test(source.url)) {
    mediaPart = { fileData: { fileUri: source.url } };
  } else if (source.path && fs.existsSync(source.path)) {
    const ext = path.extname(source.path).toLowerCase();
    const mimeType = AUDIO_MIME[ext] ?? "audio/mp3";
    const stat = await fs.promises.stat(source.path);

    if (stat.size < 15 * 1024 * 1024) {
      const data = (await fs.promises.readFile(source.path)).toString("base64");
      mediaPart = { inlineData: { mimeType, data } };
    } else {
      // Anything sizeable goes through the Files API rather than the request body.
      const uploaded = await client().files.upload({
        file: source.path,
        config: { mimeType, displayName: source.title },
      });
      let file = uploaded;
      // Gemini will not read the file until it finishes processing it.
      for (let i = 0; i < 60 && file.state === "PROCESSING"; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        file = await client().files.get({ name: file.name! });
      }
      if (file.state !== "ACTIVE") {
        throw new Error(`Gemini could not process the media file (state: ${file.state}).`);
      }
      mediaPart = { fileData: { fileUri: file.uri!, mimeType } };
    }
  } else {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "No media to transcribe.");
    return;
  }

  const { data: text, usage } = await generateText({
    need: "audio",
    system: SYSTEM,
    temperature: 0,
    parts: [`Transcribe this recording: "${source.title}".`, mediaPart],
  });

  const pieces = splitByTimecode(text);
  if (!pieces.length) {
    finishTask(task.id, task.run_id, usage, "skipped", "Transcript came back empty.");
    return;
  }

  tx(() => {
    const chunkIds = writeChunks(sourceId, pieces);
    enqueue(
      task.run_id,
      chunkIds.map((chunkId) => ({ kind: "extract" as const, payload: { chunkId }, seq: task.seq }))
    );
    db().prepare("UPDATE sources SET status='chunked' WHERE id=?").run(sourceId);
    finishTask(task.id, task.run_id, usage, "done", `Transcribed ${pieces.length} segment(s).`);
  });
}

function splitByTimecode(text: string): Piece[] {
  const parts = text.split(/<<<TIME\s+([\d:]+)>>>/g);
  if (parts.length < 3) {
    const body = text.trim();
    return body ? [{ text: body, locator: { timecode: "00:00:00" }, label: "Transcript" }] : [];
  }
  const out: Piece[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const timecode = parts[i];
    const body = (parts[i + 1] ?? "").trim();
    if (body) out.push({ text: body, locator: { timecode }, label: timecode });
  }
  return out;
}
