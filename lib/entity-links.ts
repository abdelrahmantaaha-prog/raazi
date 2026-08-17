/**
 * Finding the names in a piece of prose that the library already knows about.
 *
 * An entry that mentions Aramco, the State Department and Crown Prince Saud and
 * links to none of them is a dead end: the reader has to go back to an index and
 * search for a name they are already looking at. This turns those names into
 * things you can open.
 *
 * No database and no model — it is string matching against a candidate list the
 * caller supplies, which keeps it usable on both sides of the client boundary
 * and testable without a library.
 */

export interface LinkTarget {
  id: number;
  name: string;
  type?: string;
  aliases?: string[];
}

export interface LinkedSpan {
  text: string;
  /** Absent for ordinary prose. */
  entityId?: number;
  /** The entity's heading, which is often not the words on the page. */
  entityName?: string;
}

/**
 * Below this a name matches inside other words and inside itself: "Ali" in
 * "alliance", "UN" in "under". The sweep uses the same floor for the same
 * reason.
 */
const MIN_NAME = 4;

/** Words that are names in form and furniture in practice. */
const NOT_WORTH_LINKING = /^(the|a|an|his|her|their|this|that|it|they|he|she)\b/i;

/**
 * Splits text into spans, marking the ones that name a known entity.
 *
 * Longest names first, so "Crown Prince Saud" wins over "Saud" and the link
 * covers the whole name rather than half of it. A name already consumed by a
 * longer match cannot match again inside it.
 */
export function linkEntities(text: string, targets: LinkTarget[]): LinkedSpan[] {
  if (!text) return [];

  // Every surface a target is known by, pointing back at the target.
  const bySurface = new Map<string, LinkTarget>();
  for (const t of targets) {
    for (const surface of [t.name, ...(t.aliases ?? [])]) {
      const s = surface?.trim();
      if (!s || s.length < MIN_NAME) continue;
      if (NOT_WORTH_LINKING.test(s)) continue;
      // First claim wins, and targets arrive heaviest-first, so an ambiguous
      // surface goes to the entity with the most evidence behind it rather
      // than to whichever happened to be last.
      if (!bySurface.has(s.toLowerCase())) bySurface.set(s.toLowerCase(), t);
    }
  }
  if (bySurface.size === 0) return [{ text }];

  const surfaces = [...bySurface.keys()].sort((a, b) => b.length - a.length);

  // One pass, alternating. Unicode boundaries rather than \b, which is defined
  // against Latin word characters and fires between Arabic letters.
  let re: RegExp;
  try {
    re = new RegExp(
      `(?<![\\p{L}\\p{N}])(${surfaces
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|")})(?![\\p{L}\\p{N}])`,
      "giu"
    );
  } catch {
    return [{ text }];
  }

  const out: LinkedSpan[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    const target = bySurface.get(m[0].toLowerCase());
    if (!target) continue;
    if (start > at) out.push({ text: text.slice(at, start) });
    out.push({ text: m[0], entityId: target.id, entityName: target.name });
    at = start + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out.length ? out : [{ text }];
}
