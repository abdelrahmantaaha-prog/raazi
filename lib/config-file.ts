import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db";
import { SHARED_CONFIG, pinnedDir, rootDir } from "./disciplines";

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

/**
 * The keys, and which model does which job, live beside the registry rather
 * than in any one discipline: a key pasted once works in all of them, and a
 * key's daily quota is counted once rather than three times over. A copy
 * pointed straight at a single library (a test) keeps everything in that
 * library, so nothing reaches outside the folder it was given.
 */
const sharedPath = () => (pinnedDir() ? CONFIG_PATH : SHARED_CONFIG());

export function readStore<T extends object>(): Partial<T> {
  return readFrom<T>(CONFIG_PATH);
}

/** The settings every discipline shares. */
export function readShared<T extends object>(): Partial<T> {
  return readFrom<T>(sharedPath());
}

export function writeShared(next: object): void {
  writeTo(sharedPath(), next);
}

function readFrom<T extends object>(CONFIG_PATH: string): Partial<T> {
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
  writeTo(CONFIG_PATH, next);
}

/**
 * The same reads and writes against any one of these files — another
 * discipline's config.json, which a sync fills in while that discipline is
 * not the one open.
 */
export const readJsonFile = <T extends object>(file: string): Partial<T> => readFrom<T>(file);
export const writeJsonFile = (file: string, next: object): void => writeTo(file, next);

/** What a library keeps to itself; everything else here is shared. */
const SHARED_FIELDS = ["keys", "routing", "model", "embedModel", "lan", "followers", "follow"] as const;

let adopted = false;

/**
 * Moves the keys and the routing of a library that predates disciplines out
 * to the shared file, once.
 *
 * The library you already had holds its keys in its own config.json, because
 * when they were pasted there was nowhere else. Left there, a second
 * discipline would open with no keys at all and the first would go on
 * counting quota by itself. So the first read that finds a shared file
 * without keys, and a library that has them, carries them across — and takes
 * them out of the library's own file, so there is one home for them rather
 * than two that can disagree.
 */
export function adoptSharedConfig(): void {
  if (adopted || pinnedDir()) return;
  adopted = true;
  try {
    const shared = readFrom<Record<string, unknown>>(sharedPath());
    // The file a Corpus that predates disciplines wrote: always the one at
    // the data root, whichever discipline happens to be open now. Reading
    // only the open one meant that opening a brand new discipline first —
    // before anything had been carried across — left the keys and the LAN
    // token behind and minted a fresh token in their place, which quietly
    // unpairs the phone.
    const mine = readFrom<Record<string, unknown>>(path.join(rootDir(), "config.json"));
    // Field by field, rather than all-or-nothing on the keys: a later version
    // that shares one more thing has to be able to carry that one across on
    // its own, without the keys — already moved — stopping it.
    const moving = SHARED_FIELDS.filter((f) => mine[f] !== undefined && shared[f] === undefined);
    if (!moving.length) return;

    const next: Record<string, unknown> = { ...shared };
    for (const f of moving) next[f] = mine[f];
    writeTo(sharedPath(), next);

    const left = { ...mine };
    for (const f of moving) delete left[f];
    writeTo(path.join(rootDir(), "config.json"), left);
    console.log(`[corpus] ${moving.join(", ")} now sit beside the disciplines, shared by all of them`);
  } catch (err) {
    // Never fatal: the keys are still where they were, and the next start
    // tries again. Losing them to a half-finished move would not be.
    console.error("[corpus] could not share the keys between disciplines:", (err as Error).message);
  }
}

function writeTo(CONFIG_PATH: string, next: object): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  // Unique per process+moment: two processes writing simultaneously must not
  // share a temp file, or one renames the other's half-written bytes.
  const tmp = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
}
