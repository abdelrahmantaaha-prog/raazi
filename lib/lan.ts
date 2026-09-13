import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * LAN mode: the one shared secret between this machine and your phone.
 *
 * By default Corpus listens on 127.0.0.1 only, and nothing here applies —
 * whoever can reach it is already sitting at this computer. LAN mode is what
 * you switch on to reach the library from a phone, and it changes two things
 * at once: the server binds every interface, and every request has to carry a
 * token. The two must never be separated. A server on 0.0.0.0 without the
 * token was the state the audit found — anyone on the hotel Wi-Fi could delete
 * sources, read the keys' labels, change routing, and spend every quota.
 *
 * The token is 32 random bytes, generated once and kept in data/config.json
 * beside the API keys. It travels three ways, all equivalent:
 *
 *   - header `x-corpus-token: …`           (the Android helper, curl)
 *   - header `Authorization: Bearer …`      (anything that speaks OAuth-ish)
 *   - cookie `corpus_token=…`               (a browser, after /login?token=…)
 *
 * The middleware checks all three on every request except the two that have
 * to work before you have signed in: GET /api/hello, which is how a phone
 * finds this machine, and GET /login, which is how it signs in.
 *
 * This file reads config.json directly rather than through lib/config-file
 * because it is loaded by the middleware, which runs before every request and
 * should not pull the database driver in with it. The write path — generating
 * the token — does go through lib/config-file, lazily, so the atomic-rename
 * guarantee that protects the keys protects this too.
 */

export const LAN_COOKIE = "corpus_token";
export const LAN_HEADER = "x-corpus-token";

export interface LanSettings {
  enabled: boolean;
  /** Null until it has been generated. Never exposed without a check. */
  token: string | null;
}

interface LanStore {
  lan?: { enabled?: boolean; token?: string };
}

// The same rule as lib/db/index.ts, spelled out here so the middleware need
// not import that module (and the native driver it loads) to find the file.
const DATA_DIR = process.env.CORPUS_DATA_DIR
  ? path.resolve(process.env.CORPUS_DATA_DIR)
  : path.join(process.cwd(), "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

/** Cached by the file's mtime, so a request costs one stat rather than a parse. */
// Keyed on size as well as mtime: NTFS stamps files at a coarse resolution,
// so two writes a few milliseconds apart can carry the same mtime, and the
// second was being read as the first. Writes from this module also drop the
// cache outright, since they know the file changed.
let cache: { stamp: string; store: LanStore } | null = null;

function store(): LanStore {
  let stamp: string;
  try {
    const st = fs.statSync(CONFIG_PATH);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    cache = null;
    return {};
  }
  if (cache && cache.stamp === stamp) return cache.store;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as LanStore;
    cache = { stamp, store: parsed };
    return parsed;
  } catch {
    // Unreadable. lib/config-file quarantines it on its next read; here the
    // safe reading is "no token", which fails closed when LAN mode is on.
    cache = null;
    return {};
  }
}

/** Whether LAN mode is on: the environment (set by the `:lan` scripts and the
 *  launcher) or the saved preference, either is enough. */
export function lanEnabled(): boolean {
  if (process.env.CORPUS_LAN === "1") return true;
  return store().lan?.enabled === true;
}

export function lanSettings(): LanSettings {
  const s = store();
  const token = typeof s.lan?.token === "string" && s.lan.token.length >= 32 ? s.lan.token : null;
  return { enabled: lanEnabled(), token };
}

/**
 * Generates the token if there is none, and returns it.
 *
 * Goes through lib/config-file so the write is atomic and a torn file can
 * never take the API keys with it. Imported lazily for the reason given at the
 * top: this is the only path here that needs it, and it is taken once.
 */
export async function ensureLanToken(): Promise<string> {
  const current = lanSettings().token;
  if (current) return current;
  const { readStore, writeStore } = await import("./config-file");
  const s = readStore<LanStore>();
  if (typeof s.lan?.token === "string" && s.lan.token.length >= 32) return s.lan.token;
  const token = crypto.randomBytes(32).toString("hex");
  writeStore({ ...s, lan: { ...(s.lan ?? {}), token } });
  cache = null;
  return token;
}

/** Records the preference; the launcher reads it to pick the bind address. */
export async function setLanEnabled(enabled: boolean): Promise<LanSettings> {
  const { readStore, writeStore } = await import("./config-file");
  const s = readStore<LanStore>();
  writeStore({ ...s, lan: { ...(s.lan ?? {}), enabled } });
  cache = null;
  if (enabled) await ensureLanToken();
  return lanSettings();
}

/** The token a request carries, from whichever of the three places it used. */
export function tokenFrom(req: {
  headers: { get(name: string): string | null };
  cookies?: { get(name: string): { value: string } | undefined };
}): string | null {
  const header = req.headers.get(LAN_HEADER);
  if (header) return header.trim();
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const cookie = req.cookies?.get(LAN_COOKIE)?.value;
  if (cookie) return cookie;
  // A plain Request has no cookie jar; read the header by hand.
  const raw = req.headers.get("cookie") ?? "";
  const m = new RegExp(`(?:^|;\\s*)${LAN_COOKIE}=([^;]+)`).exec(raw);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Constant-time, so a token cannot be guessed a byte at a time. */
export function tokenMatches(candidate: string | null, expected: string | null): boolean {
  if (!candidate || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** This machine's IPv4 addresses on real networks — what a phone would type. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.internal) continue;
      if (addr.family !== "IPv4" && (addr.family as unknown) !== 4) continue;
      // Link-local means "no DHCP answered"; nobody reaches a machine on it.
      if (addr.address.startsWith("169.254.")) continue;
      out.push(addr.address);
    }
  }
  return out;
}

/** The URL a phone opens once to sign in; the same thing the QR code carries. */
export function loginUrls(port: number, token: string): string[] {
  return lanAddresses().map((ip) => `http://${ip}:${port}/login?token=${token}`);
}

/**
 * The page shown to a browser that has not signed in. Plain HTML, because the
 * app's own pages are behind the very check that is failing.
 */
export function signInPage(reason: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Corpus — sign in</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;background:#f6f2ea;color:#2a2622;margin:0;padding:2rem 1.25rem;max-width:32rem}
  h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:.5rem 0 1rem;color:#5a534b}
  input{font:inherit;width:100%;box-sizing:border-box;padding:.6rem .7rem;border:1px solid #c9c1b4;border-radius:6px;background:#fff}
  button{font:inherit;margin-top:.75rem;padding:.6rem 1rem;border:0;border-radius:6px;background:#7a4b2a;color:#fff}
</style></head><body>
<h1>Corpus</h1>
<p>${esc(reason)}</p>
<form method="get" action="/login">
  <label>Token<br><input name="token" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
  <button type="submit">Sign in</button>
</form>
<p>The token is in Settings on the computer running Corpus, as a link you can open or scan.</p>
</body></html>`;
}
