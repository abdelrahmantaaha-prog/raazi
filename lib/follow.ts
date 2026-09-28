import os from "node:os";
import { readShared as readStore, writeShared as writeStore } from "./config-file";
import {
  SyncConflictError,
  fingerprint,
  peerFetch,
  peerStatus,
  pullFrom,
  syncInFlight,
  uploadTo,
  type Peer,
} from "./sync";
import { followSettings, hostOf, isFollower, saveFollowSettings, type FollowRecord } from "./follow-state";

export { followSettings, isFollower, saveFollowSettings } from "./follow-state";

/**
 * Working from another computer's Corpus, with a copy here for when it is gone.
 *
 * The launcher on the laptop opens the window on the primary — the machine at
 * home — and runs a second, quiet Corpus beside it: the follower. The follower
 * never runs the worker (lib/worker.ts), so it reads nothing, polls nothing
 * and spends nothing; all it does is keep its library in step with the
 * primary's, a whole copy at a time, whenever the primary's has moved.
 *
 * When the primary stops answering, the launcher says so and the window moves
 * to the follower, which has everything up to its last copy. Work done there
 * is ordinary work in an ordinary library. When the primary answers again the
 * follower compares the two against where they stood at the last sync:
 *
 *   neither moved            nothing to do
 *   only the primary moved   take a copy of it (spaced out while both are up)
 *   only this copy moved     send it back; the primary installs it
 *   both moved               ask — a library is copied whole, and two that
 *                            both changed cannot be merged. Whichever is not
 *                            kept survives as a backup on its own machine.
 *
 * The primary does its part at start-up: it waits briefly for a follower it
 * has seen before to check in, so work done on the laptop while this machine
 * was off comes back before the primary starts its own worker and opens.
 */

/** While both are up, a copy is taken at most this often, however busy the primary. */
export const FOLLOW_PULL_EVERY_MS = 5 * 60_000;

export type FollowAction = "adopt" | "first-sync" | "in-step" | "wait" | "pull" | "push" | "conflict";

/** What to do, from what changed on each side since the last sync. Pure. */
export function decide(input: {
  localKey: string;
  primaryKey: string;
  last: FollowRecord | null;
  sinceLastPullMs: number | null;
  /** Coming back from an outage: catch up at once rather than on the schedule. */
  returning: boolean;
}): FollowAction {
  if (!input.last) return input.localKey === input.primaryKey ? "adopt" : "first-sync";
  const localChanged = input.localKey !== input.last.localKey;
  const primaryChanged = input.primaryKey !== input.last.primaryKey;
  if (!localChanged && !primaryChanged) return "in-step";
  if (localChanged && primaryChanged) return "conflict";
  if (localChanged) return "push";
  if (!input.returning && input.sinceLastPullMs !== null && input.sinceLastPullMs < FOLLOW_PULL_EVERY_MS) return "wait";
  return "pull";
}

export interface FollowTick {
  state: "not-following" | "in-step" | "pulled" | "behind" | "pushed" | "offline" | "conflict" | "busy" | "error";
  primaryHost: string | null;
  primaryUp: boolean;
  offlineSince: string | null;
  lastSyncAt: string | null;
  message: string;
  at: string;
}

let lastTick: FollowTick | null = null;
let ticking = false;
/**
 * When a copy from the primary last failed. Only a successful pull used to
 * start the wait between copies, so a failing one was retried on every tick —
 * every few seconds — and each try had the primary make a whole copy.
 */
let pullFailedAt: number | null = null;

/** Tells the primary this follower exists, and whether it is about to send work back. */
async function checkIn(peer: Peer, bringingWork: boolean): Promise<void> {
  try {
    await peerFetch(
      peer,
      "/api/sync/checkin",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: os.hostname(), bringingWork }),
      },
      8_000
    );
  } catch {
    /* the primary hears from us on the next tick */
  }
}

/**
 * One step of following. The launcher calls it every few seconds; each call
 * looks at both libraries once and does at most one copy.
 */
export async function followTick(opts: { resolve?: "keep-local" | "keep-primary" } = {}): Promise<FollowTick> {
  const s = followSettings();
  const host = s.primaryUrl ? hostOf(s.primaryUrl) : null;
  const report = (state: FollowTick["state"], message: string): FollowTick => {
    const now = followSettings();
    lastTick = {
      state,
      primaryHost: host,
      primaryUp: state !== "offline" && state !== "not-following",
      offlineSince: now.offlineSince,
      lastSyncAt: now.last?.at ?? null,
      message,
      at: new Date().toISOString(),
    };
    return lastTick;
  };

  if (!s.primaryUrl) return report("not-following", "This copy is not following another Corpus.");
  const busy = syncInFlight();
  if (ticking || busy) return report("busy", busy ? `A sync is already running (${busy}).` : "Already checking.");

  ticking = true;
  try {
    const peer: Peer = { url: s.primaryUrl, token: s.primaryToken };
    let theirs: Awaited<ReturnType<typeof peerStatus>>;
    try {
      theirs = await peerStatus(peer);
    } catch (err) {
      if (!s.offlineSince) saveFollowSettings({ offlineSince: new Date().toISOString() });
      return report("offline", `${host} is not answering. ${(err as Error).message}`);
    }

    const mine = fingerprint();
    const returning = Boolean(s.offlineSince);
    const primaryKey = theirs.fingerprint.workKey ?? theirs.fingerprint.key;
    let action = decide({
      localKey: mine.workKey,
      primaryKey,
      last: s.last,
      sinceLastPullMs: s.pulledAt ? Date.now() - Date.parse(s.pulledAt) : null,
      returning,
    });
    if (opts.resolve === "keep-local") action = "push";
    if (opts.resolve === "keep-primary") action = "pull";

    await checkIn(peer, action === "push");

    // Both keys are this library's own after a copy either way: the two are
    // the same library at that moment, whichever direction it went.
    const record = (direction: "pull" | "push") => {
      const key = fingerprint().workKey;
      const at = new Date().toISOString();
      saveFollowSettings({
        last: { at, localKey: key, primaryKey: key, direction },
        offlineSince: null,
        ...(direction === "pull" ? { pulledAt: at } : {}),
      });
    };

    switch (action) {
      case "adopt":
        record("pull");
        return report("in-step", `In step with ${host}.`);
      case "in-step":
        if (returning) saveFollowSettings({ offlineSince: null });
        return report("in-step", `In step with ${host}.`);
      case "wait":
        return report("behind", `${host} has moved on; this copy catches up within a few minutes.`);
      case "first-sync":
      case "pull":
        if (!opts.resolve && pullFailedAt !== null && Date.now() - pullFailedAt < FOLLOW_PULL_EVERY_MS) {
          const next = new Date(pullFailedAt + FOLLOW_PULL_EVERY_MS).toLocaleTimeString();
          return report("behind", `The last copy from ${host} failed; the next try is at ${next}.`);
        }
        try {
          await pullFrom(peer, { force: true });
        } catch (err) {
          if (!/already the same/.test((err as Error).message)) {
            pullFailedAt = Date.now();
            throw err;
          }
        }
        pullFailedAt = null;
        record("pull");
        return report("pulled", `Brought up to date from ${host}.`);
      case "push": {
        const force = opts.resolve === "keep-local";
        await uploadTo(peer, { expect: force ? null : s.last?.primaryKey ?? null, force });
        record("push");
        await checkIn(peer, false);
        return report("pushed", `What was done on this computer is on ${host} now.`);
      }
      case "conflict":
      default:
        return report(
          "conflict",
          `Since they last matched${s.last ? ` (${new Date(s.last.at).toLocaleString()})` : ""}, both changed. ` +
            `This computer: ${mine.sources} sources, ${mine.drafts} drafts, ${mine.decided} inbox decisions. ` +
            `${host}: ${theirs.fingerprint.sources} sources, ${theirs.fingerprint.drafts} drafts, ${theirs.fingerprint.decided} inbox decisions.`
        );
    }
  } catch (err) {
    if (err instanceof SyncConflictError) return report("conflict", `${host} changed as well. ${err.message}`);
    return report("error", (err as Error).message.slice(0, 300));
  } finally {
    ticking = false;
  }
}

/** What a page may be told about following: never the token. */
export function followView() {
  const s = followSettings();
  return {
    follower: isFollower(),
    primaryHost: s.primaryUrl ? hostOf(s.primaryUrl) : null,
    lastSyncAt: s.last?.at ?? null,
    offlineSince: s.offlineSince,
    state: lastTick?.state ?? null,
    message: lastTick?.message ?? null,
    checkedAt: lastTick?.at ?? null,
  };
}

// ---------------------------------------------------------------------------
// The primary's side
// ---------------------------------------------------------------------------

interface FollowerRecord {
  lastSeen: string;
  bringingWork: boolean;
}

interface FollowersStore {
  followers?: Record<string, FollowerRecord>;
}

/** Followers heard from by this process, which is what "since start-up" means. */
const sinceBoot = new Map<string, { at: number; bringingWork: boolean }>();

/** How long a follower is remembered — and waited for at start-up — after it was last heard from. */
const FOLLOWER_MEMORY_MS = 30 * 24 * 60 * 60_000;
/** A check-in is written down at most this often, since one arrives every few seconds. */
const PERSIST_EVERY_MS = 10 * 60_000;
/** A follower that said it was bringing work and then went quiet has stopped trying. */
const BRINGING_STALE_MS = 30 * 60_000;

export function recordCheckin(c: { host: string; bringingWork: boolean }): void {
  const host = c.host.trim().slice(0, 100);
  if (!host) return;
  const first = !sinceBoot.has(host);
  sinceBoot.set(host, { at: Date.now(), bringingWork: c.bringingWork });

  const store = readStore<FollowersStore>();
  const saved = store.followers?.[host];
  const due =
    first || !saved || saved.bringingWork !== c.bringingWork || Date.now() - Date.parse(saved.lastSeen) > PERSIST_EVERY_MS;
  if (due) {
    writeStore({
      ...store,
      followers: { ...(store.followers ?? {}), [host]: { lastSeen: new Date().toISOString(), bringingWork: c.bringingWork } },
    });
  }
}

/**
 * What the launcher asks before it opens the primary: is there a follower that
 * might be bringing work back, has it checked in, and is its copy arriving now.
 */
export function primaryWaiting() {
  const known = readStore<FollowersStore>().followers ?? {};
  const remembered = Object.entries(known)
    .filter(([, f]) => Date.now() - Date.parse(f.lastSeen) < FOLLOWER_MEMORY_MS)
    .map(([host]) => host);
  const hosts = [...new Set([...remembered, ...sinceBoot.keys()])];
  return {
    expect: remembered.length > 0,
    host: hosts[0] ?? null,
    followers: hosts,
    checkedIn: hosts.some((h) => sinceBoot.has(h)),
    bringingWork: [...sinceBoot.values()].some((c) => c.bringingWork && Date.now() - c.at < BRINGING_STALE_MS),
    receiving: /^receiving/.test(syncInFlight() ?? ""),
  };
}
