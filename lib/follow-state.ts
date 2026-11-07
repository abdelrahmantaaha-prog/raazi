import { readShared as readStore, writeShared as writeStore } from "./config-file";

/**
 * What a follower remembers: which Raazi it follows, and where the two stood
 * when they last matched. Kept apart from lib/follow.ts, which does the
 * copying, so reading it pulls in nothing else.
 */

export interface FollowRecord {
  at: string;
  /** This copy's work key right after the last sync. */
  localKey: string;
  /** The primary's, as that sync left it — the same library, so the same key. */
  primaryKey: string;
  direction: "pull" | "push";
}

export interface FollowSettings {
  primaryUrl: string;
  primaryToken: string;
  last: FollowRecord | null;
  /** When the primary first stopped answering, until it answers again. */
  offlineSince: string | null;
  /** The last copy taken, for spacing them out. */
  pulledAt: string | null;
}

interface Store {
  follow?: Partial<FollowSettings>;
}

/** Whether this server is a follower's copy: started by the launcher to keep in step with another Raazi. */
export function isFollower(): boolean {
  return process.env.CORPUS_FOLLOWER === "1";
}

export function followSettings(): FollowSettings {
  const s = readStore<Store>().follow ?? {};
  return {
    primaryUrl: typeof s.primaryUrl === "string" ? s.primaryUrl : "",
    primaryToken: typeof s.primaryToken === "string" ? s.primaryToken : "",
    last: s.last ?? null,
    offlineSince: typeof s.offlineSince === "string" ? s.offlineSince : null,
    pulledAt: typeof s.pulledAt === "string" ? s.pulledAt : null,
  };
}

export function saveFollowSettings(patch: Partial<FollowSettings>): FollowSettings {
  const store = readStore<Store>();
  writeStore({ ...store, follow: { ...(store.follow ?? {}), ...patch } });
  return followSettings();
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
