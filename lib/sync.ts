import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import Database from "better-sqlite3";
import { DATA_DIR, SOURCES_DIR, db } from "./db";
import { readStore, writeStore } from "./config-file";
import { COVERS_DIR } from "./covers";
import { PORTRAITS_DIR } from "./portraits";
import { ensureLanToken, lanAddresses, lanEnabled } from "./lan";
import { kickWorker, stopWorker, workerStatus } from "./worker";

/**
 * Two laptops, one library.
 *
 * The problem this solves is continuity, not collaboration: you work on one
 * machine, it fails or stays at the office, and you carry on from the other
 * as if nothing happened. So sync is a copy, not a merge. A library is one
 * SQLite file and a folder of source files, ids run through every table, and
 * merging two of them row by row would be a year's work that guessed wrong
 * on the day it mattered. Copying the whole thing is a minute over a LAN and
 * cannot half-succeed.
 *
 * Two verbs, both from Settings on the machine you are sitting at:
 *
 *   pull  — this library becomes a copy of the peer's. Yours is backed up
 *           first, whole, under data/backups.
 *   push  — the peer's library becomes a copy of this one. Implemented as
 *           "ask the peer to pull from me", so there is one code path.
 *
 * Both machines have to be in LAN mode, because that is what makes one
 * reachable by the other and what puts a token on the door. Tailscale
 * addresses (100.x) work like any other; the LAN check in lib/net.ts guards
 * the feed fetcher, not this, so a peer on a private address is allowed.
 *
 * What is copied: corpus.db (as a VACUUM INTO snapshot, so it is consistent
 * while the peer keeps running), and every file under sources/, covers/ and
 * portraits/ that is missing or a different size here. What is not:
 * config.json — API keys, routing, the LAN token — because each machine keeps
 * its own keys and its own door.
 *
 * Safety, in the order it is applied on a pull: the peer's snapshot is
 * downloaded and opened read-only and integrity-checked before anything here
 * is touched; the worker is asked to stop and given a minute to finish the
 * task it is on; the current library is moved to a dated backup, never
 * deleted; the snapshot is renamed into place; the database reopens through
 * the ordinary path, migrations and all. If the local library has changed
 * since the last sync the pull is refused unless forced, and the Settings
 * page says exactly what would be lost.
 */

export interface SyncSettings {
  peerUrl: string;
  peerToken: string;
  /** The last sync, whichever way it went. */
  last: { at: string; peer: string; direction: "pull" | "push"; fingerprint: string } | null;
}

interface SyncStore {
  sync?: Partial<SyncSettings>;
}

export function syncSettings(): SyncSettings {
  const s = readStore<SyncStore>().sync ?? {};
  return {
    peerUrl: typeof s.peerUrl === "string" ? s.peerUrl : "",
    peerToken: typeof s.peerToken === "string" ? s.peerToken : "",
    last: s.last ?? null,
  };
}

export function saveSyncSettings(patch: Partial<SyncSettings>): SyncSettings {
  const store = readStore<SyncStore>();
  const next = { ...(store.sync ?? {}), ...patch };
  if (typeof next.peerUrl === "string") next.peerUrl = next.peerUrl.trim().replace(/\/+$/, "");
  if (typeof next.peerToken === "string") next.peerToken = next.peerToken.trim();
  writeStore({ ...store, sync: next });
  return syncSettings();
}

/**
 * A short description of the library's state, for telling two copies apart.
 *
 * Counts and latest timestamps over the tables that change when you work.
 * Not a hash of the file — WAL checkpoints and index rebuilds change bytes
 * without changing anything you did — and cheap enough to compute on every
 * Settings load.
 */
export interface Fingerprint {
  sources: number;
  chunks: number;
  mentions: number;
  entries: number;
  drafts: number;
  feedItems: number;
  decided: number;
  briefs: number;
  latest: string | null;
  key: string;
  /**
   * The same without the queue's bookkeeping. Opening a copy puts interrupted
   * tasks back in the queue and a run's timestamp moves whenever it is looked
   * at; neither is work, and a follower comparing copies must not mistake them
   * for it.
   */
  workKey: string;
}

function tableExists(name: string): boolean {
  return Boolean(db().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export function fingerprint(): Fingerprint {
  const count = (sql: string) => (db().prepare(sql).get() as { n: number }).n;
  const latestOf = (sql: string) => (db().prepare(sql).get() as { t: string | null }).t;
  const drafts = tableExists("drafts") ? count("SELECT COUNT(*) AS n FROM drafts") : 0;
  const work = [
    latestOf("SELECT MAX(added_at) AS t FROM sources"),
    latestOf("SELECT MAX(kept_at) AS t FROM sources"),
    latestOf("SELECT MAX(starred_at) AS t FROM sources"),
    latestOf("SELECT MAX(updated_at) AS t FROM entries"),
    latestOf("SELECT MAX(decided_at) AS t FROM feed_items"),
    latestOf("SELECT MAX(created_at) AS t FROM briefs"),
    tableExists("drafts") ? latestOf("SELECT MAX(updated_at) AS t FROM drafts") : null,
    tableExists("brief_expansions") ? latestOf("SELECT MAX(updated_at) AS t FROM brief_expansions") : null,
  ].filter((t): t is string => Boolean(t));
  const runsAt = latestOf("SELECT MAX(updated_at) AS t FROM runs");
  const stamps = runsAt ? [...work, runsAt] : [...work];
  const workLatest = [...work].sort().at(-1) ?? "";
  const f = {
    sources: count("SELECT COUNT(*) AS n FROM sources"),
    chunks: count("SELECT COUNT(*) AS n FROM chunks"),
    mentions: count("SELECT COUNT(*) AS n FROM mentions"),
    entries: count("SELECT COUNT(*) AS n FROM entries"),
    drafts,
    feedItems: count("SELECT COUNT(*) AS n FROM feed_items"),
    decided: count("SELECT COUNT(*) AS n FROM feed_items WHERE decided_at IS NOT NULL"),
    briefs: count("SELECT COUNT(*) AS n FROM briefs"),
    latest: stamps.sort().at(-1) ?? null,
  };
  const counts = [f.sources, f.chunks, f.mentions, f.entries, f.drafts, f.feedItems, f.decided, f.briefs].join("|");
  return { ...f, key: `${counts}|${f.latest ?? ""}`, workKey: `${counts}|${workLatest}` };
}

export interface LocalStatus {
  app: "corpus";
  host: string;
  version: string;
  lan: boolean;
  port: number;
  addresses: string[];
  libraryBytes: number;
  fingerprint: Fingerprint;
  last: SyncSettings["last"];
  /** True when something here changed after the last sync — what a pull would overwrite. */
  changedSinceSync: boolean;
  syncing: string | null;
}

let syncing: string | null = null;
export function syncInFlight(): string | null {
  return syncing;
}

export function localStatus(): LocalStatus {
  const f = fingerprint();
  const s = syncSettings();
  let libraryBytes = 0;
  try {
    libraryBytes = fs.statSync(path.join(DATA_DIR, "corpus.db")).size;
  } catch {
    /* no file yet */
  }
  return {
    app: "corpus",
    host: os.hostname(),
    version: process.env.npm_package_version ?? "0.0.0",
    lan: lanEnabled(),
    port: Number(process.env.PORT ?? 5400),
    addresses: lanAddresses(),
    libraryBytes,
    fingerprint: f,
    last: s.last,
    changedSinceSync: Boolean(s.last) && s.last!.fingerprint !== f.key,
    syncing,
  };
}

// ---------------------------------------------------------------------------
// Serving a copy
// ---------------------------------------------------------------------------

const SYNC_DIR = path.join(DATA_DIR, "sync");
const BACKUPS_DIR = path.join(DATA_DIR, "backups");

/** A copy in data/sync older than this is what a failed or abandoned sync left behind. */
const STALE_COPY_MS = 60 * 60_000;
/** After a copy fails, the next is refused for this long — a follower asks again every few seconds. */
const COPY_RETRY_AFTER_MS = 5 * 60_000;
/** Room kept free beyond the copy itself, so a copy never fills the drive. */
const COPY_HEADROOM_BYTES = 512 * 1024 * 1024;

/**
 * Deletes copies a failed or abandoned sync left in data/sync. Each can be as
 * large as the library: on 28 Sep 2026 a follower retrying every ten seconds
 * against a nearly full drive left 1.3 GB of half-written ones there.
 */
export function sweepStaleCopies(now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(SYNC_DIR);
  } catch {
    return 0;
  }
  for (const name of names) {
    const m = /^(?:snapshot|received|incoming)-(\d+)\.db(?:-journal|-wal|-shm)?$/.exec(name);
    if (!m || now - Number(m[1]) < STALE_COPY_MS) continue;
    try {
      fs.unlinkSync(path.join(SYNC_DIR, name));
      removed++;
    } catch {
      /* still open somewhere; the next sweep has it */
    }
  }
  return removed;
}

function removeCopy(file: string): void {
  for (const f of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* never written */
    }
  }
}

let copyFailed: { at: number; message: string } | null = null;

/**
 * A consistent copy of the database, written while it stays in use.
 *
 * SQLite's online backup, a hundred pages at a time, handing the event loop
 * back between steps. It used to be one VACUUM INTO statement, and
 * better-sqlite3 runs statements synchronously: the whole server stood still
 * for as long as copying 200-odd MB took — no page, no answer to a window's
 * check-in — so every open window put up "The Corpus server is down" while a
 * follower took its copy. The worker writes through the same connection, so
 * its writes reach the copy as it is made rather than restarting it.
 *
 * A copy that fails is deleted, and a drive without room for one is refused
 * before a byte is written. After a failure the next copy waits five minutes,
 * whoever asks: a follower on an older version retries on every tick.
 */
export async function snapshot(): Promise<string> {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  sweepStaleCopies();
  if (copyFailed && Date.now() - copyFailed.at < COPY_RETRY_AFTER_MS) {
    const next = new Date(copyFailed.at + COPY_RETRY_AFTER_MS).toLocaleTimeString();
    throw new Error(`The last copy of this library failed (${copyFailed.message}). The next is allowed at ${next}.`);
  }
  const conn = db();
  const need =
    (conn.pragma("page_count", { simple: true }) as number) * (conn.pragma("page_size", { simple: true }) as number);
  const disk = fs.statfsSync(SYNC_DIR);
  const free = disk.bavail * disk.bsize;
  if (free < need + COPY_HEADROOM_BYTES) {
    const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
    const message = `the drive has ${mb(free)} free; a copy needs ${mb(need)} and leaves ${mb(COPY_HEADROOM_BYTES)} spare`;
    copyFailed = { at: Date.now(), message };
    throw new Error(`Not enough room for a copy of this library: ${message}.`);
  }
  const file = path.join(SYNC_DIR, `snapshot-${Date.now()}.db`);
  try {
    await conn.backup(file);
    // The copy carries the source's WAL mode in its header; a single file in
    // rollback mode is what gets sent and installed.
    const copy = new Database(file);
    try {
      copy.pragma("journal_mode = DELETE");
    } finally {
      copy.close();
    }
  } catch (err) {
    removeCopy(file);
    copyFailed = { at: Date.now(), message: (err as Error).message.slice(0, 200) };
    throw err;
  }
  copyFailed = null;
  return file;
}

export interface SyncFile {
  rel: string;
  size: number;
}

const FILE_ROOTS: [string, string][] = [
  ["sources", SOURCES_DIR],
  ["covers", COVERS_DIR],
  ["portraits", PORTRAITS_DIR],
];

/** Every file a copy of this library needs, as paths relative to data/. */
export function listFiles(): SyncFile[] {
  const out: SyncFile[] = [];
  for (const [name, dir] of FILE_ROOTS) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const st = fs.statSync(path.join(dir, entry.name));
      out.push({ rel: `${name}/${entry.name}`, size: st.size });
    }
  }
  return out;
}

/** The absolute path a relative one names, or null when it points outside. */
export function resolveFile(rel: string): string | null {
  const m = /^(sources|covers|portraits)\/([^/\\]+)$/.exec(rel);
  if (!m || m[2] === "." || m[2] === "..") return null;
  const root = FILE_ROOTS.find(([n]) => n === m[1])![1];
  const abs = path.join(root, m[2]);
  if (!abs.startsWith(root)) return null;
  return abs;
}

// ---------------------------------------------------------------------------
// Taking a copy
// ---------------------------------------------------------------------------

export interface Peer {
  url: string;
  token: string;
}

export async function peerFetch(peer: Peer, route: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const url = `${peer.url.replace(/\/+$/, "")}${route}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), "x-corpus-token": peer.token },
      signal: ctrl.signal,
    });
    if (res.status === 401) throw new Error("The peer refused the token. Check it against the peer's Settings → LAN mode.");
    return res;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error(`No answer from ${peer.url} within ${Math.round(timeoutMs / 1000)}s.`);
    throw new Error(`Could not reach ${peer.url}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** What the other machine says about itself. */
export async function peerStatus(peer: Peer): Promise<LocalStatus> {
  const res = await peerFetch(peer, "/api/sync/status", {}, 8_000);
  if (!res.ok) throw new Error(`The peer answered ${res.status} to a status request.`);
  const data = (await res.json()) as LocalStatus;
  if (data.app !== "corpus") throw new Error("Something answered, but it is not Corpus.");
  return data;
}

export interface PullResult {
  from: string;
  backup: string | null;
  filesCopied: number;
  bytesCopied: number;
  fingerprint: Fingerprint;
  peerFingerprint: Fingerprint;
  tookMs: number;
}

/**
 * Stops the worker and waits for the task it is on. A model call can run for
 * minutes, and swapping the database under it would have its result written
 * into the wrong library, so this refuses rather than proceeds.
 */
async function quiesce(timeoutMs: number): Promise<void> {
  stopWorker();
  const until = Date.now() + timeoutMs;
  while (workerStatus().running) {
    if (Date.now() > until) {
      throw new Error("The worker is mid-task and did not stop in time. Pause the run in Activity, or try again in a minute.");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Makes this library a copy of a snapshot file. Shared by pull and by the
 * tests, which hand it a file they wrote themselves.
 *
 * Every step before the rename is a check; every step after is recoverable
 * from the backup. The rename itself is the one moment of truth, and it is
 * a rename on the same volume, so it is atomic.
 */
export async function installSnapshot(
  file: string,
  opts: { backup?: boolean; quiesceMs?: number } = {}
): Promise<{ backup: string | null; fingerprint: Fingerprint }> {
  // 1. The candidate must be a Corpus library that SQLite is happy with.
  const probe = new Database(file, { readonly: true });
  try {
    const check = probe.pragma("quick_check", { simple: true }) as string;
    if (check !== "ok") throw new Error(`The copy failed SQLite's check: ${String(check).slice(0, 200)}`);
    const has = probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sources'").get();
    if (!has) throw new Error("The copy has no sources table; it is not a Corpus library.");
  } finally {
    probe.close();
  }

  // 2. Nothing may be writing.
  await quiesce(opts.quiesceMs ?? 120_000);

  // 3. Let go of the current file.
  const live = globalThis.__corpusDb;
  if (live) {
    try {
      live.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* best effort; close() checkpoints too */
    }
    live.close();
    globalThis.__corpusDb = undefined;
  }

  // 4. Keep what was here.
  const dbPath = path.join(DATA_DIR, "corpus.db");
  let backup: string | null = null;
  if (fs.existsSync(dbPath)) {
    if (opts.backup !== false) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
      backup = path.join(BACKUPS_DIR, `corpus-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
      fs.renameSync(dbPath, backup);
      pruneBackups(3);
    } else {
      fs.unlinkSync(dbPath);
    }
  }
  for (const side of ["-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbPath}${side}`);
    } catch {
      /* not there */
    }
  }

  // 5. The moment of truth.
  fs.renameSync(file, dbPath);

  // 6. Reopen through the front door, so migrations and recovery run as on
  //    any boot, and point file paths at this machine's folders.
  const opened = db();
  relocatePaths(opened);
  return { backup, fingerprint: fingerprint() };
}

/** Source files were recorded by absolute path on the peer; the names carry over. */
function relocatePaths(d: Database.Database) {
  const rows = d.prepare("SELECT id, path FROM sources WHERE path IS NOT NULL").all() as { id: number; path: string }[];
  const update = d.prepare("UPDATE sources SET path=? WHERE id=?");
  for (const r of rows) {
    const local = path.join(SOURCES_DIR, path.basename(r.path.replace(/\\/g, "/")));
    if (local !== r.path) update.run(local, r.id);
  }
}

function pruneBackups(keep: number) {
  const files = fs
    .readdirSync(BACKUPS_DIR)
    .filter((f) => /^corpus-.*\.db$/.test(f))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try {
      fs.unlinkSync(path.join(BACKUPS_DIR, f));
    } catch {
      /* a backup that will not delete is still a backup */
    }
  }
}

/** Downloads a peer's snapshot to data/sync and returns its path. */
async function download(peer: Peer): Promise<string> {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  const file = path.join(SYNC_DIR, `incoming-${Date.now()}.db`);
  const res = await peerFetch(peer, "/api/sync/snapshot", {}, 30 * 60_000);
  if (!res.ok || !res.body) {
    const said = ((await res.json().catch(() => ({}))) as { error?: string }).error;
    throw new Error(said ?? `The peer answered ${res.status} to a snapshot request.`);
  }
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), fs.createWriteStream(file));
  } catch (err) {
    removeCopy(file);
    throw err;
  }
  return file;
}

/** Copies every file the peer has that this machine lacks. */
async function copyFiles(peer: Peer): Promise<{ copied: number; bytes: number }> {
  const res = await peerFetch(peer, "/api/sync/files");
  if (!res.ok) throw new Error(`The peer answered ${res.status} to a file listing.`);
  const theirs = (await res.json()) as { files: SyncFile[] };
  const mine = new Map(listFiles().map((f) => [f.rel, f.size]));
  let copied = 0;
  let bytes = 0;
  for (const f of theirs.files) {
    if (mine.get(f.rel) === f.size) continue;
    const abs = resolveFile(f.rel);
    if (!abs) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const r = await peerFetch(peer, `/api/sync/file?path=${encodeURIComponent(f.rel)}`, {}, 10 * 60_000);
    if (!r.ok || !r.body) continue;
    const tmp = `${abs}.${process.pid}.part`;
    await pipeline(Readable.fromWeb(r.body as import("node:stream/web").ReadableStream), fs.createWriteStream(tmp));
    fs.renameSync(tmp, abs);
    copied++;
    bytes += f.size;
  }
  return { copied, bytes };
}

/**
 * This library becomes a copy of the peer's.
 *
 * Refused when something here changed since the last sync, unless forced —
 * the Settings page shows what would go and asks. Refused too when the two
 * are already the same, because a pull that changes nothing still costs a
 * restart of the worker.
 */
export async function pullFrom(peer: Peer, opts: { force?: boolean } = {}): Promise<PullResult> {
  if (syncing) throw new Error(`A sync is already running (${syncing}).`);
  syncing = `pulling from ${peer.url}`;
  const started = Date.now();
  try {
    const theirs = await peerStatus(peer);
    const mine = localStatus();
    if (theirs.fingerprint.key === mine.fingerprint.key) {
      throw new Error("The two libraries are already the same.");
    }
    if (mine.changedSinceSync && !opts.force) {
      throw new Error("This library has changed since the last sync. Pulling would replace those changes — say so to go ahead.");
    }

    const file = await download(peer);
    let installed: Awaited<ReturnType<typeof installSnapshot>>;
    try {
      installed = await installSnapshot(file);
    } catch (err) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
      throw err;
    }
    const files = await copyFiles(peer);

    saveSyncSettings({
      last: { at: new Date().toISOString(), peer: peer.url, direction: "pull", fingerprint: installed.fingerprint.key },
    });
    kickWorker();
    return {
      from: theirs.host,
      backup: installed.backup,
      filesCopied: files.copied,
      bytesCopied: files.bytes,
      fingerprint: installed.fingerprint,
      peerFingerprint: theirs.fingerprint,
      tookMs: Date.now() - started,
    };
  } finally {
    syncing = null;
  }
}

/**
 * The peer's library becomes a copy of this one: it is asked to pull from
 * here. Needs LAN mode on this machine, since the peer has to reach it.
 *
 * Which of this machine's addresses the peer can reach is not knowable from
 * here — a Tailscale address works from anywhere, a Wi-Fi one only on the
 * same network — so all of them are sent and the peer tries each.
 */
export async function pushTo(peer: Peer, opts: { force?: boolean } = {}): Promise<PullResult> {
  if (!lanEnabled()) {
    throw new Error("Pushing needs LAN mode on here, so the other laptop can fetch from this one. Switch it on and restart Corpus.");
  }
  if (syncing) throw new Error(`A sync is already running (${syncing}).`);
  syncing = `pushing to ${peer.url}`;
  try {
    const token = await ensureLanToken();
    const port = Number(process.env.PORT ?? 5400);
    const addresses = lanAddresses().map((ip) => `http://${ip}:${port}`);
    if (!addresses.length) throw new Error("This machine has no network address a peer could reach.");
    const res = await peerFetch(
      peer,
      "/api/sync/pull",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addresses, token, force: Boolean(opts.force) }),
      },
      30 * 60_000
    );
    const data = (await res.json().catch(() => ({}))) as PullResult & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `The peer answered ${res.status}.`);
    saveSyncSettings({
      last: { at: new Date().toISOString(), peer: peer.url, direction: "push", fingerprint: fingerprint().key },
    });
    return data;
  } finally {
    syncing = null;
  }
}

// ---------------------------------------------------------------------------
// Sending a copy, for a follower bringing its work back
// ---------------------------------------------------------------------------

/** The other library moved on too: installing this copy would lose that. */
export class SyncConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncConflictError";
  }
}

/** Larger than any library should be; a stream past it is not a library. */
const MAX_SNAPSHOT_BYTES = 16 * 1024 ** 3;
const MAX_FILE_BYTES = 4 * 1024 ** 3;

/** Passes bytes through, and fails past a limit rather than filling the disk. */
function capped(limit: number, what: string): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > limit) done(new Error(`${what} is larger than any Corpus should send.`));
      else done(null, chunk);
    },
  });
}

/**
 * Makes this library a copy of one sent to it — a follower bringing back what
 * was done on it while this machine could not be reached.
 *
 * Pull, run the other way round: the follower sends, so this machine never
 * has to reach the laptop, which is usually the one behind a firewall. The
 * safety is pull's: the copy is checked before anything is touched, and this
 * library is kept as a backup. And one more check, first: `expect` is this
 * library's work key as the follower last saw it. If this library has moved
 * since, installing the copy would throw that away, so it is refused unless
 * forced — the follower asks you which to keep.
 */
export async function receiveSnapshot(
  body: ReadableStream<Uint8Array>,
  opts: { from: string; expect?: string | null; force?: boolean }
): Promise<{ backup: string | null; fingerprint: Fingerprint }> {
  if (syncing) {
    await body.cancel().catch(() => undefined);
    throw new Error(`A sync is already running (${syncing}).`);
  }
  if (opts.expect && !opts.force && opts.expect !== fingerprint().workKey) {
    await body.cancel().catch(() => undefined);
    throw new SyncConflictError("This library has changed since the copy being sent was taken from it.");
  }

  syncing = `receiving from ${opts.from}`;
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  const file = path.join(SYNC_DIR, `received-${Date.now()}.db`);
  try {
    await pipeline(
      Readable.fromWeb(body as import("node:stream/web").ReadableStream),
      capped(MAX_SNAPSHOT_BYTES, "The copy"),
      fs.createWriteStream(file)
    );
    const installed = await installSnapshot(file);
    saveSyncSettings({
      last: { at: new Date().toISOString(), peer: opts.from, direction: "pull", fingerprint: installed.fingerprint.key },
    });
    kickWorker();
    return installed;
  } catch (err) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* consumed by the install, or never written */
    }
    throw err;
  } finally {
    syncing = null;
  }
}

/** One file of a library being sent here, written where the listing names it and nowhere else. */
export async function receiveFile(rel: string, body: ReadableStream<Uint8Array>): Promise<number> {
  const abs = resolveFile(rel);
  if (!abs) {
    await body.cancel().catch(() => undefined);
    throw new Error("Not a file a Corpus library keeps.");
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.part`;
  try {
    await pipeline(
      Readable.fromWeb(body as import("node:stream/web").ReadableStream),
      capped(MAX_FILE_BYTES, "A file"),
      fs.createWriteStream(tmp)
    );
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never written */
    }
    throw err;
  }
  return fs.statSync(abs).size;
}

/**
 * Sends this library to a peer, which installs it: the follower's half of
 * bringing work back. Then every file the peer lacks, or holds at a different
 * size. `expect` is the peer's work key as this machine last copied it; the
 * peer refuses if it has moved since.
 */
export async function uploadTo(
  peer: Peer,
  opts: { expect?: string | null; force?: boolean } = {}
): Promise<{ fingerprint: Fingerprint; filesSent: number; bytesSent: number }> {
  if (syncing) throw new Error(`A sync is already running (${syncing}).`);
  syncing = `sending to ${peer.url}`;
  let file = "";
  try {
    // Inside the try: a copy that fails must still clear `syncing`, or every
    // later sync on this machine reports one already running.
    file = await snapshot();
    const query = new URLSearchParams({ from: os.hostname() });
    if (opts.expect) query.set("expect", opts.expect);
    if (opts.force) query.set("force", "1");
    const res = await peerFetch(
      peer,
      `/api/sync/receive?${query}`,
      {
        method: "POST",
        headers: { "content-type": "application/vnd.sqlite3" },
        body: Readable.toWeb(fs.createReadStream(file)) as ReadableStream,
        // A streamed request body has to say it will not wait for the response.
        duplex: "half",
      } as RequestInit,
      60 * 60_000
    );
    const data = (await res.json().catch(() => ({}))) as { error?: string; conflict?: boolean };
    if (res.status === 409 && data.conflict) throw new SyncConflictError(data.error ?? "The other library has changed too.");
    if (!res.ok) throw new Error(data.error ?? `The peer answered ${res.status} to the copy.`);

    const listing = await peerFetch(peer, "/api/sync/files");
    if (!listing.ok) throw new Error(`The peer answered ${listing.status} to a file listing.`);
    const theirs = new Map(((await listing.json()) as { files: SyncFile[] }).files.map((f) => [f.rel, f.size]));
    let filesSent = 0;
    let bytesSent = 0;
    for (const f of listFiles()) {
      if (theirs.get(f.rel) === f.size) continue;
      const abs = resolveFile(f.rel);
      if (!abs) continue;
      const put = await peerFetch(
        peer,
        `/api/sync/receive-file?path=${encodeURIComponent(f.rel)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: Readable.toWeb(fs.createReadStream(abs)) as ReadableStream,
          duplex: "half",
        } as RequestInit,
        30 * 60_000
      );
      if (!put.ok) continue;
      filesSent++;
      bytesSent += f.size;
    }
    return { fingerprint: fingerprint(), filesSent, bytesSent };
  } finally {
    syncing = null;
    if (file) removeCopy(file);
  }
}

/**
 * The first of several addresses that answers as a Corpus, for a push that
 * arrives with a list. Tried in parallel; the first hello wins.
 */
export async function reachable(addresses: string[], token: string): Promise<Peer> {
  const attempts = addresses.map(async (url) => {
    const res = await peerFetch({ url, token }, "/api/hello", {}, 5_000);
    const data = (await res.json()) as { app?: string };
    if (data.app !== "corpus") throw new Error("not corpus");
    return { url, token };
  });
  try {
    return await Promise.any(attempts);
  } catch {
    throw new Error(`None of the addresses offered (${addresses.join(", ")}) answered as a Corpus.`);
  }
}
