/**
 * One grammar for whitespace in model output.
 *
 * A model asked for JSON sometimes escapes its newlines twice: it writes
 * `\\n` where it means `\n`, so `JSON.parse` hands back a string carrying a
 * literal backslash and an `n` rather than a line break. Nothing downstream
 * looks for that, so it was written to the database and published as it
 * stood — on 20 September 2026 it had reached 23 entry bodies, 3 of the 10
 * briefs and 20 revision changelogs.
 *
 * The damage is not cosmetic. An entry whose body is half real newlines and
 * half literal ones (John Kennedy, Amy Klobuchar) prints its section heading
 * twice and then runs every paragraph after it together into one block with
 * `\n` visible in the prose. And `fixedSections` in the brief splits a
 * changelog on a real newline to take its first line: given a literal one it
 * finds no break, treats the whole list as line one, and cuts it mid-word at
 * 220 characters — which is how "…as i" and "…for Chinese wor" were
 * published.
 *
 * This is the same shape as the citation-marker bug of 3 September: the
 * writer emitting one grammar and every reader expecting another. It gets
 * the same remedy — one rule, applied at the boundary where model output
 * enters the app, so no stage has to remember it.
 */

/** The escapes worth undoing: whitespace, where a literal is never meant. */
const ESCAPES: [RegExp, string][] = [
  [/\\r\\n/g, "\n"],
  [/\\n/g, "\n"],
  [/\\r/g, "\n"],
  [/\\t/g, "\t"],
];

/**
 * Turns literal `\n` back into a line break.
 *
 * A fenced code block is left alone: inside one, a backslash followed by an
 * `n` can be exactly what the passage is quoting, and a pedia that covers
 * technology will eventually hold one.
 */
export function unescapeText(value: string): string {
  if (value.includes("```")) return value;
  let out = value;
  for (const [pattern, replacement] of ESCAPES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * The same rule over a whole parsed response: every string value, however
 * deep, with keys left as they are. Applied by each provider adapter the
 * moment `JSON.parse` returns, so extraction, entries, briefs, verification
 * and grouping all get it without asking.
 */
export function unescapeModelJson<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return unescapeText(value);
  if (Array.isArray(value)) return value.map(walk);
  // Plain objects only. A Date or a class instance coming back from
  // JSON.parse is not a thing that happens, and rebuilding one would lose it.
  if (value !== null && typeof value === "object" && isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = walk(inner);
    return out;
  }
  return value;
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
