import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db";

/**
 * The one file that must never be lost, and the two rules that keep it.
 *
 * `data/config.json` holds every API key on the ring. It is rewritten after
 * every single model call (`markUsed`), which made the old code a standing
 * hazard with two halves:
 *
 *  - the write was `writeFileSync` straight over the live file, so a process
 *    killed mid-write — tray Quit is `taskkill /F` — left truncated JSON;
 *  - the read swallowed the resulting parse error and returned `{}`, so the
 *    next write, arriving within seconds, persisted the empty object. Thirty-
 *    seven keys gone, silently, with no error logged anywhere.
 *
 * So: every write lands in a temp file first and is renamed into place —
 * `rename` on the same volume is atomic on Windows and POSIX alike, so the
 * file is always either the old version or the new one, never a torn half.
 * And a file that exists but does not parse is never treated as empty: it is
 * moved aside to a timestamped `.corrupt-*` backup, loudly, so the secrets
 * survive for hand recovery and later writes cannot bury them.
 *
 * Both lib/config.ts (settings) and lib/keys.ts (the ring) go through here.
 * They used to each own a private copy of read/write against the same path,
 * which is how a fix applied to one would have quietly missed the other.
 */

const CONFIG_PATH = path.join(DATA_DIR, "config.json");

export function readStore<T extends object>(): Partial<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    // Only "no such file" is first run, where empty is the truth. Anything
    // else — EBUSY while another process renames over it, EPERM from a
    // scanner holding it, EISDIR — is a file that exists and could not be
    // read this instant. Returning {} there is the parse-failure disaster in
    // a different coat: the next markUsed would persist the empty object
    // over every key. So the caller gets the error, and nothing is written.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw err;
  }

  try {
    return JSON.parse(raw) as Partial<T>;
  } catch {
    // Present but unreadable. Quarantine it rather than shadowing it with {}:
    // once it is out of the way, "no file" is true again, and the damaged
    // original — with whatever keys it still holds — is sitting beside it.
    const backup = `${CONFIG_PATH}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(CONFIG_PATH, backup);
      console.error(
        `[corpus] config.json was unreadable — moved to ${path.basename(backup)}. ` +
          `If keys are missing, recover them from that file.`
      );
    } catch {
      console.error("[corpus] config.json is unreadable and could not be moved aside.");
    }
    return {};
  }
}

export function writeStore(next: object): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Unique per process+moment: two processes writing simultaneously must not
  // share a temp file, or one renames the other's half-written bytes.
  const tmp = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
}
