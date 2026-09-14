import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { duration } from "./ffmpeg.mjs";

/**
 * Reads one line aloud and returns the audio with a timing for every word.
 * Cached by voice, rate and text, so re-running the film only fetches the
 * lines that changed.
 */
export async function narrate(text, { voice, rate = "+0%", dir }) {
  const key = crypto.createHash("sha1").update(`${voice}|${rate}|${text}`).digest("hex").slice(0, 16);
  const out = path.join(dir, key);
  const audio = path.join(out, "audio.mp3");
  const meta = path.join(out, "metadata.json");

  if (!fs.existsSync(audio) || !fs.existsSync(meta)) {
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    for (let attempt = 1; ; attempt++) {
      try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
        await tts.toFile(out, text, { rate });
        tts.close();
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }

  // Offsets and durations arrive in 100-nanosecond ticks.
  const raw = fs.readFileSync(meta, "utf8");
  const words = [...raw.matchAll(/"Offset":\s*(\d+),\s*"Duration":\s*(\d+),\s*"text":\s*\{\s*"Text":\s*"([^"]*)"/g)]
    .map((m) => ({ start: +m[1] / 1e7, end: (+m[1] + +m[2]) / 1e7, text: m[3] }));
  return { audio, words, duration: duration(audio) };
}
