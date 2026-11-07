import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * Microsoft's "Natural" voices, fetched by the server rather than the browser.
 *
 * Edge reads pages aloud with these voices and exposes them to web pages
 * through speech synthesis; no other browser does. Opened in Brave or Chrome,
 * the reader had only the machine's own voices, which are flat by comparison.
 * The voices themselves come from the service Edge's Read Aloud talks to, so
 * the server talks to it the same way and hands the browser plain audio —
 * which any browser can play.
 *
 * This is not a published API. It is the endpoint Edge itself uses, with the
 * token every copy of Edge carries, and it is what the widely used `edge-tts`
 * tool speaks to as well. Microsoft can change it without notice; when that
 * happens the reader falls back to the machine's own voices rather than going
 * silent. The usual breakage is the browser version below going stale, so
 * that is the first thing to bump.
 *
 * Unlike the machine's voices, this sends the paragraph being read to
 * Microsoft. That is why it only happens when you choose one of these voices.
 */

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM = "143.0.3650.75";
const BASE = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROMIUM.split(".")[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM.split(".")[0]}.0.0.0`;

/** Seconds between 1601 (Windows file time) and 1970 (Unix time). */
const WIN_EPOCH = 11644473600;

/**
 * Seconds our clock is off from Microsoft's. The token below is only good for
 * five minutes either side of the server's time, so a machine with a drifting
 * clock is told off with a 403 — whose Date header is then used to correct it.
 */
let skew = 0;

/**
 * The rolling token the service expects alongside the fixed one: a hash of the
 * current five-minute window in Windows ticks. It is how Edge proves it is
 * Edge, and every copy computes the same thing.
 */
export function secMsGec(now = Date.now() / 1000 + skew): string {
  let ticks = now + WIN_EPOCH;
  ticks -= ticks % 300;
  // Ticks are 100 ns. BigInt, because the value is past what a double holds
  // exactly and the hash is of its digits.
  const digits = (BigInt(Math.floor(ticks)) * BigInt(10_000_000)).toString();
  return createHash("sha256").update(`${digits}${TOKEN}`, "ascii").digest("hex").toUpperCase();
}

function query(): string {
  return `TrustedClientToken=${TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM}`;
}

function headers(): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    Origin: ORIGIN,
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
    "Accept-Language": "en-US,en;q=0.9",
    // A per-connection id Edge sends as a cookie; the service has started
    // refusing requests without one.
    Cookie: `muid=${randomBytes(16).toString("hex").toUpperCase()};`,
  };
}

/** Learns the server's clock from a refusal, so the next try is in its window. */
function adjustClock(date: string | null): boolean {
  const server = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(server)) return false;
  const next = server / 1000 - Date.now() / 1000;
  if (Math.abs(next - skew) < 1) return false;
  skew = next;
  return true;
}

export interface EdgeVoice {
  /** e.g. "en-US-AvaMultilingualNeural" — what SSML names it by. */
  id: string;
  /** e.g. "Ava Multilingual". */
  name: string;
  lang: string;
  gender: string;
}

let voiceCache: { at: number; voices: EdgeVoice[] } | null = null;

/**
 * The voices the service offers, in the languages Raazi reads.
 *
 * Several hundred exist; only Arabic and English are kept, because those are
 * the two scripts the reader tells apart, and a menu of four hundred voices to
 * find Hamed in is not a menu. Cached for a day.
 */
export async function edgeVoices(): Promise<EdgeVoice[]> {
  if (voiceCache && Date.now() - voiceCache.at < 86_400_000) return voiceCache.voices;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`https://${BASE}/voices/list?${query()}`, {
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 403 && attempt === 0 && adjustClock(res.headers.get("date"))) continue;
    if (!res.ok) throw new Error(`The voice list answered ${res.status}.`);

    const raw = (await res.json()) as {
      ShortName: string;
      FriendlyName?: string;
      Locale: string;
      Gender?: string;
    }[];
    const voices = raw
      .filter((v) => /^(ar|en)-/i.test(v.Locale))
      .map((v) => ({
        id: v.ShortName,
        name: friendly(v.ShortName),
        lang: v.Locale,
        gender: v.Gender ?? "",
      }))
      .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    voiceCache = { at: Date.now(), voices };
    return voices;
  }
  throw new Error("The voice list refused the request.");
}

/** "en-US-AvaMultilingualNeural" → "Ava Multilingual". */
function friendly(shortName: string): string {
  const base = shortName.split("-").slice(2).join("-").replace(/Neural$/, "");
  return base.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Text as it has to appear inside SSML. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The timestamp format Edge sends, which the service is particular about. */
function stamp(): string {
  return new Date().toUTCString().replace("GMT", "GMT+0000 (Coordinated Universal Time)");
}

/**
 * Speaks `text` in `voice` and returns the MP3.
 *
 * `rate` is the reader's multiplier — 1.5 is half again as fast — and is sent
 * as the voice's own speaking rate rather than applied by speeding up the
 * audio afterwards, which is what keeps a fast Natural voice natural.
 */
export async function edgeSpeak(text: string, voice: string, rate = 1): Promise<Buffer> {
  if (!/^[a-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z]+$/.test(voice)) throw new Error("Not a voice name.");
  try {
    return await synthesize(text, voice, rate);
  } catch (err) {
    // A refusal is nearly always the clock; `synthesize` has adjusted it.
    if ((err as { clock?: boolean }).clock) return synthesize(text, voice, rate);
    throw err;
  }
}

function synthesize(text: string, voice: string, rate: number): Promise<Buffer> {
  const url = `wss://${BASE}/edge/v1?${query()}&ConnectionId=${randomUUID().replace(/-/g, "")}`;
  // Node's own WebSocket, which — unlike a browser's — accepts headers. The
  // service checks the Origin.
  const ws = new WebSocket(url, { headers: headers() } as unknown as string[]);
  ws.binaryType = "arraybuffer";

  const percent = Math.round((rate - 1) * 100);
  const lang = voice.split("-").slice(0, 2).join("-");
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='${percent >= 0 ? "+" : ""}${percent}%' volume='+0%'>` +
    `${escapeXml(text)}</prosody></voice></speak>`;

  return new Promise<Buffer>((resolve, reject) => {
    const audio: Buffer[] = [];
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      if (err) reject(err);
      else if (audio.length === 0) reject(new Error("The voice service sent no audio."));
      else resolve(Buffer.concat(audio));
    };
    const timer = setTimeout(() => finish(new Error("The voice service took too long.")), 30_000);

    ws.addEventListener("open", () => {
      ws.send(
        `X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},` +
          `"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`
      );
      ws.send(
        `X-RequestId:${randomUUID().replace(/-/g, "")}\r\nContent-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${stamp()}Z\r\nPath:ssml\r\n\r\n${ssml}`
      );
    });

    ws.addEventListener("message", (event) => {
      const data = event.data as string | ArrayBuffer;
      if (typeof data === "string") {
        if (data.includes("Path:turn.end")) finish(null);
        return;
      }
      // A binary frame: two bytes giving the header's length, the header, then
      // the audio. Only frames whose header says audio carry any.
      const buf = Buffer.from(data);
      if (buf.length < 2) return;
      const headerLength = buf.readUInt16BE(0);
      const header = buf.subarray(2, 2 + headerLength).toString("utf8");
      if (header.includes("Path:audio")) audio.push(buf.subarray(2 + headerLength));
    });

    ws.addEventListener("error", (event) => {
      // Node reports a refused handshake as an error with the response on it.
      const res = (event as unknown as { error?: { response?: Response } }).error?.response;
      const clock = res?.status === 403 && adjustClock(res.headers.get("date"));
      const err = new Error(
        res ? `The voice service refused the connection (${res.status}).` : "Could not reach the voice service."
      ) as Error & { clock?: boolean };
      err.clock = clock;
      finish(err);
    });

    ws.addEventListener("close", () => finish(audio.length ? null : new Error("The voice service hung up.")));
  });
}
