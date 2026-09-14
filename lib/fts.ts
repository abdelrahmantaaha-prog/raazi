/**
 * What a search box types, made safe for SQLite.
 *
 * Shared by the inbox's search and the writing desk's library search, which
 * both read words someone is still in the middle of typing. Pure string
 * functions, no dependencies.
 */

/** The words of a query, as a search box means them. */
export function queryWords(q: string, max = 12): string[] {
  return (q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, max);
}

/**
 * Words made safe for the full-text index: each quoted, so nothing typed is
 * read as syntax; the last a prefix, so results arrive while it is still being
 * typed; and words with no letter or digit in them, which index as nothing,
 * left out. Null when nothing usable is left.
 */
export function ftsMatch(words: string[]): string | null {
  const usable = words.map((w) => w.replace(/"/g, "")).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (!usable.length) return null;
  return usable.map((w, n) => `"${w}"${n === usable.length - 1 ? "*" : ""}`).join(" ");
}

/** A LIKE pattern for the word itself: a typed % or _ is a character, not a wildcard. Pair with ESCAPE '\'. */
export function likePattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
