/**
 * Citation markers, and the one grammar every reader of an entry agrees on.
 *
 * An entry cites a passage with `[[m:ID]]`. Four modules parse that — the entry
 * writer, the renderer, the coherence guard and the verifier — and until this
 * file existed each carried its own regex. They agreed with each other and
 * disagreed with the model: asked to cite two passages, the writer produced
 * `[[m:42993], [m:39206]]` (several ids inside one pair of brackets), which none
 * of the four could read. Those citations rendered as nothing, counted as
 * uncited, were never verified, and the coverage rule then rewrote the entry —
 * 106 of 785 entries, one of them 184 times.
 *
 * So the grammar is normalised here, once, before anything reads it. Pure
 * string functions with no dependencies, so the client renderer and the
 * migration can both use them.
 */

/** One well-formed marker. Global, so reset lastIndex if you reuse it. */
export const MARKER_RE = /\[\[m:(\d+)\]\]/g;

/**
 * Rewrites every citation the model might plausibly emit into `[[m:ID]]`,
 * one marker per id, separated by a space:
 *
 *   [[m:1], [m:2]]      → [[m:1]] [[m:2]]
 *   [[m:1, m:2, m:3]]   → [[m:1]] [[m:2]] [[m:3]]
 *   [[m:1; m:2]]        → [[m:1]] [[m:2]]
 *   [m:12]              → [[m:12]]
 *   [[ m:12 ]]          → [[m:12]]
 *   [[m:12]][[m:13]]    → [[m:12]] [[m:13]]
 *
 * Prose containing an ordinary bracketed word is left alone.
 */
export function normaliseMarkers(md: string): string {
  if (!md) return md;
  let s = md;

  // Several ids inside one bracket pair, with any of the separators seen.
  s = s.replace(
    /\[\[\s*m:\s*\d+\s*(?:\]?\s*[,;/]\s*\[?\s*m:\s*\d+\s*)+\]\]/g,
    (run) => [...run.matchAll(/m:\s*(\d+)/g)].map((m) => `[[m:${m[1]}]]`).join(" ")
  );

  // A single-bracket marker.
  s = s.replace(/(?<!\[)\[\s*m:\s*(\d+)\s*\](?!\])/g, "[[m:$1]]");

  // Stray whitespace inside a marker.
  s = s.replace(/\[\[\s*m:\s*(\d+)\s*\]\]/g, "[[m:$1]]");

  // Markers butted together, or joined with a comma or semicolon: "[[m:1]],
  // [[m:2]]" was the older writer's habit and it reads as a list.
  s = s.replace(/\]\]\s*[,;]?\s*\[\[m:/g, "]] [[m:");

  return s;
}

/** The distinct mention ids a body cites, after normalisation. */
export function citedIds(body: string): Set<number> {
  const out = new Set<number>();
  for (const m of normaliseMarkers(body).matchAll(MARKER_RE)) out.add(Number(m[1]));
  return out;
}

/** True when the text contains at least one marker. */
export function hasMarker(text: string): boolean {
  return /\[\[m:\d+\]\]/.test(text);
}

/** The text with every marker removed, for reading or measuring prose. */
export function stripMarkers(text: string): string {
  return text.replace(/\s*\[\[m:\d+\]\]/g, "").replace(/[ \t]{2,}/g, " ").trim();
}
