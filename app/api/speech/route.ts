import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { edgeSpeak } from "@/lib/edge-voice";

export const dynamic = "force-dynamic";

/**
 * One piece of a paragraph, spoken in a Natural voice, as MP3.
 *
 * The reader asks for the next paragraph while the current one plays, and
 * going back a paragraph asks for one it has already heard, so recent answers
 * are kept: a few minutes of audio, a few megabytes.
 */
const recent = new Map<string, Buffer>();
const KEEP = 60;

/** Well over a piece the reader sends, well under what the service takes. */
const MAX_CHARS = 3000;

export async function POST(req: Request) {
  const body = await readBody<{ text?: unknown; voice?: unknown; rate?: unknown }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  const { text, voice } = body;
  if (typeof text !== "string" || !text.trim()) return badRequest("Nothing to say.");
  if (text.length > MAX_CHARS) return badRequest(`At most ${MAX_CHARS} characters at a time.`);
  if (typeof voice !== "string") return badRequest("voice must be a voice name.");
  const rate = typeof body.rate === "number" && Number.isFinite(body.rate) ? Math.min(3, Math.max(0.5, body.rate)) : 1;

  const key = createHash("sha256").update(`${voice}\n${rate}\n${text}`).digest("hex");
  let audio = recent.get(key);
  if (audio) {
    // Refreshed, so the oldest is what goes when the map is full.
    recent.delete(key);
  } else {
    try {
      audio = await edgeSpeak(text, voice, rate);
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 502 });
    }
  }
  recent.set(key, audio);
  while (recent.size > KEEP) recent.delete(recent.keys().next().value!);

  return new Response(new Uint8Array(audio), {
    headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
  });
}
