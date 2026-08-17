/**
 * What an idea can be, with no database behind it.
 *
 * Split from lib/ideas.ts for the reason lib/discard-reasons.ts is split from
 * lib/audit.ts: the picker is a client component, and a client component that
 * imports a module touching better-sqlite3 fails the build with "Can't resolve
 * 'fs'". Types are erased and can be imported from anywhere; a runtime value
 * like this list cannot.
 */

export type IdeaState = "seed" | "developing" | "drafted" | "parked";

export const IDEA_STATES: { id: IdeaState; label: string; hint: string }[] = [
  { id: "seed", label: "Seed", hint: "A thought, not yet worked out." },
  { id: "developing", label: "Developing", hint: "Being shaped — it has an outline." },
  { id: "drafted", label: "Drafted", hint: "It became a draft." },
  { id: "parked", label: "Parked", hint: "Set aside, kept on purpose." },
];

/** How deep an outline may go. Past this it stops being an outline. */
export const MAX_OUTLINE_DEPTH = 2;
