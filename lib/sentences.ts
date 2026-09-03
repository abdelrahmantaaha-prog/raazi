/**
 * Splitting prose into sentences without being fooled by "U.S.".
 *
 * The verifier judges an entry one sentence at a time, and a sentence is only
 * judged against the citations it carries. Splitting on every full stop turned
 * "U.S. officials said the tariff would hold [[m:12]]." into two fragments —
 * "U.S." with no citation and the rest with one — and then flagged the first
 * as unsupported. On a North America beat that abbreviation is in every third
 * sentence, and each false flag was another rewrite.
 *
 * This splitter knows the common Latin-script abbreviations, never splits
 * inside a citation marker, never splits after a lone initial ("J. Smith"),
 * and only splits where the next character could start a sentence. Arabic and
 * other scripts split on their own terminators. It is a heuristic; it errs
 * towards *not* splitting, because an unsplit pair of sentences is judged
 * together (harmless) while a split fragment is judged alone (a false flag).
 */

const ABBREVIATIONS = new Set(
  [
    "u.s", "u.k", "u.n", "e.u", "u.s.a", "d.c", "n.y", "l.a",
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "ft",
    "gen", "lt", "col", "sgt", "capt", "maj", "cmdr", "adm", "brig",
    "rep", "sen", "gov", "pres", "sec", "amb", "hon", "rev", "fr", "msgr",
    "vs", "etc", "inc", "ltd", "co", "corp", "no", "nos", "dept", "univ",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
    "p", "pp", "ed", "eds", "vol", "ch", "fig", "approx", "ca", "cf", "e.g", "i.e", "viz",
    "al", "op", "cit", "ibid", "esp", "para", "sec", "art",
  ].map((a) => a.toLowerCase())
);

/** Characters that end a sentence, in the scripts this library holds. */
const TERMINATOR = /[.!?؟。]+["'”’)\]»]*\s+/g;

/**
 * Sentences of a paragraph, in order, trimmed, with their citation markers
 * still attached. Returns the whole text as one sentence when no boundary is
 * found.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  TERMINATOR.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = TERMINATOR.exec(text))) {
    const end = m.index + m[0].length;
    if (!boundaryAt(text, m.index, end)) continue;
    const s = text.slice(start, end).trim();
    if (s) out.push(s);
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.length ? out : [text.trim()].filter(Boolean);
}

/** Whether the terminator at `at` genuinely ends a sentence. */
function boundaryAt(text: string, at: number, end: number): boolean {
  const before = text.slice(0, at);
  const after = text.slice(end);

  // Inside a citation marker: "[[m:12]]" never contains a terminator, but a
  // sentence may end "…said [[m:12]]. " — that is fine. What must not split is
  // a marker straddling the boundary, which cannot happen with a well-formed
  // marker, so only guard the open-bracket case.
  const lastOpen = before.lastIndexOf("[[");
  const lastClose = before.lastIndexOf("]]");
  if (lastOpen > lastClose) return false;

  // A full stop that belongs to an abbreviation.
  if (text[at] === ".") {
    const word = lastWord(before);
    if (word !== null) {
      const lower = word.toLowerCase();
      // "No." is an abbreviation only in front of a number ("No. 10"); the
      // word "no" ends a sentence like any other.
      if (lower === "no" || lower === "nos") {
        if (/^\d/.test(after)) return false;
      } else if (ABBREVIATIONS.has(lower)) return false;
      // A lone initial: "J. Smith", "George W. Bush".
      if (/^[A-Z]$/.test(word)) return false;
      // A number with a decimal or an ordinal list marker: "3." at line start.
      if (/^\d+$/.test(word) && before.trimEnd().length === word.length) return false;
    }
  }

  // What follows must be able to open a sentence: a capital, a digit, an
  // opening quote or bracket, a citation marker, or a letter from a script
  // without case.
  if (!after) return true;
  const next = after[0];
  if (/[\p{Lu}\d"'“‘(\[«]/u.test(next)) return true;
  if (/\p{L}/u.test(next) && !/[\p{Ll}]/u.test(next)) return true; // caseless script
  return false;
}

/** The token before a full stop, letters and internal dots only. */
function lastWord(before: string): string | null {
  const m = /([\p{L}\d]+(?:\.[\p{L}\d]+)*)$/u.exec(before);
  return m ? m[1] : null;
}

/**
 * Paragraph-aware split: sentences grouped by the paragraph they sit in, with
 * headings and blank lines dropped. Each sentence knows which paragraph it
 * belongs to, which is what lets a framing sentence be judged against its
 * neighbours' citations.
 */
export function paragraphSentences(md: string): { paragraph: number; text: string }[] {
  const out: { paragraph: number; text: string }[] = [];
  const paras = md
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#{1,6}\s/.test(p));

  paras.forEach((p, i) => {
    const flat = p
      .split("\n")
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/^\s*>\s?/, ""))
      .join(" ");
    for (const s of splitSentences(flat)) out.push({ paragraph: i, text: s });
  });
  return out;
}
