/**
 * How much an article in the inbox matters, in four stages.
 *
 *   breaking  — happening now; the desk drops everything for it.
 *   high      — significant news today on a subject that matters.
 *   medium    — routine news: updates, reactions, the smaller story.
 *   evergreen — not tied to the day: analysis, explainers, features, history.
 *
 * The stage is given once per item by the cheap model that sorts the inbox
 * (lib/inbox-importance.ts) and stored on the item. This module is the
 * neutral half both sides need — the inbox page sorts with it, the server
 * validates with it — so it imports nothing.
 */

export const IMPORTANCE = ["breaking", "high", "medium", "evergreen"] as const;
export type Importance = (typeof IMPORTANCE)[number];

export const IMPORTANCE_LABEL: Record<Importance, string> = {
  breaking: "Breaking",
  high: "High",
  medium: "Medium",
  evergreen: "Evergreen",
};

export const isImportance = (v: unknown): v is Importance =>
  typeof v === "string" && (IMPORTANCE as readonly string[]).includes(v);

/** Breaking news is breaking for a day; after that it is simply important. */
export const BREAKING_FOR_MS = 24 * 3600_000;

/** The stage as it stands now: a breaking item more than a day old counts as high. */
export function effectiveImportance(
  level: string | null | undefined,
  publishedAt: string | null | undefined,
  now = Date.now()
): Importance | null {
  if (!isImportance(level)) return null;
  if (level !== "breaking" || !publishedAt) return level;
  const t = Date.parse(publishedAt);
  return Number.isFinite(t) && now - t > BREAKING_FOR_MS ? "high" : level;
}

/**
 * Lower sorts first. An item not rated yet sits after medium and before
 * evergreen: it may be anything, but evergreen is known to be able to wait.
 */
export function importanceRank(level: Importance | null): number {
  switch (level) {
    case "breaking":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "evergreen":
      return 4;
    default:
      return 3;
  }
}

/**
 * Where a topic goes, from the ranks of its articles: its most important
 * article first, and among topics equal on that, the one with more articles
 * at that level. Lower sorts first.
 */
export function topicScore(ranks: number[]): number {
  if (!ranks.length) return Number.MAX_SAFE_INTEGER;
  const best = Math.min(...ranks);
  const atBest = ranks.filter((r) => r === best).length;
  return best * 1000 - Math.min(atBest, 999);
}
