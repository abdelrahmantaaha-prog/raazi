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
 *
 * An acronym is the exception: the boundaries are Unicode letter boundaries,
 * so "CIA" cannot match inside "special", and three capitals are a name in a
 * way three lowercase letters are not. Two-letter ones ("UN", "US") stay out —
 * they are too often a word in another language or a stray initialism.
 */
const MIN_NAME = 4;
const MIN_ACRONYM = 3;
const ACRONYM = /^[\p{Lu}][\p{Lu}\p{N}.&-]*$/u;

/** Words that are names in form and furniture in practice. */
const FURNITURE = /^(the|a|an|his|her|their|this|that|it|they|he|she)\b(.*)$/is;

/**
 * "The White House" and "The Globe and Mail" are names; "the party" is not.
 * The article alone used to disqualify the whole surface, which silently
 * unlinked every organisation whose name begins with one. A surface that opens
 * with furniture is now allowed through when what follows the article is
 * capitalised — that is, when the sources treated it as a proper name.
 */
function worthLinking(surface: string): boolean {
  const m = FURNITURE.exec(surface);
  if (!m) return true;
  return /\p{Lu}/u.test(m[2]);
}

function longEnough(surface: string): boolean {
  if (surface.length >= MIN_NAME) return true;
  return surface.length >= MIN_ACRONYM && ACRONYM.test(surface);
}

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
      if (!s || !longEnough(s)) continue;
      if (!worthLinking(s)) continue;
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
