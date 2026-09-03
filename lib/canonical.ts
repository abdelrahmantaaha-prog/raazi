/**
 * Which of an entity's names to show.
 *
 * Resolution already gets the *identity* right — "President Truman" and
 * "Harry S. Truman" end up on one entity with both as aliases. What was wrong
 * was the label: whichever surface happened to appear first became the heading,
 * so entries were titled "General Donahue" while carrying "Christopher Donahue"
 * as an alias.
 *
 * So the display name is chosen rather than inherited. A reader wants the
 * fullest plain form of the name: given and family names, no rank, no shouting.
 */

import { stripLeadingTitles } from "./normalize";

const TITLE_WORDS = new Set([
  "dr", "dr.", "prof", "prof.", "professor", "mr", "mr.", "mrs", "mrs.", "ms", "ms.",
  "sir", "lord", "lady", "rev", "rev.", "president", "vice", "king", "queen",
  "crown", "grand", "lt", "lt.", "lieutenant", "brigadier", "brig", "brig.",
  "admiral", "adm", "adm.", "marshal", "field", "commander", "cmdr", "cmdr.",
  "archbishop", "bishop", "cardinal", "rabbi", "pope", "shah", "tsar", "czar",
  "prince", "princess", "sheikh", "shaykh", "imam", "sayyid", "general", "gen",
  "gen.", "colonel", "col", "col.", "captain", "capt", "capt.", "major", "senator",
  "sen", "sen.", "governor", "gov", "gov.", "minister", "secretary", "sultan",
  "emir", "amir", "pasha", "bey", "ambassador", "judge", "justice", "chancellor",
  "الدكتور", "الدكتورة", "الأستاذ", "السيد", "السيدة", "الشيخ", "الملك", "الملكة",
  "الأمير", "الرئيس", "الوزير", "اللواء", "العميد", "المهندس", "السلطان",
]);

/**
 * Whether a name leads with a rank — including a two-word one, which the
 * word-by-word list cannot see: "minister" is in it, but in "Prime Minister
 * Netanyahu" it is the second word, so the form scored as a clean name and was
 * chosen as the heading.
 */
function startsWithTitle(name: string): boolean {
  const words = name.trim().split(/\s+/);
  if (words.length === 0) return false;
  if (TITLE_WORDS.has(words[0].toLowerCase())) return true;
  return stripLeadingTitles(words, 1).length < words.length;
}

/** "Sidhwa, Feroze" is a catalogue form, not how anyone writes a name. */
function isInverted(name: string): boolean {
  return /^[^,]+,\s+[^,]+$/.test(name.trim()) && name.split(",").length === 2;
}

function isShouted(name: string): boolean {
  const letters = name.replace(/[^\p{L}]/gu, "");
  if (letters.length < 4) return false;
  return letters === letters.toUpperCase() && /\p{Ll}/u.test(letters.toLowerCase());
}

/** Name particles that stay lower-case inside a name: "Abdullah al-Saud", "Ludwig van Beethoven". */
const PARTICLES = new Set([
  "al", "el", "bin", "ibn", "bint", "abu", "de", "del", "della", "di", "da", "do",
  "dos", "das", "du", "la", "le", "les", "von", "van", "der", "den", "ter", "of",
  "the", "and", "y", "e", "zu", "af", "av",
]);

/**
 * Short words that are names of things rather than words, and must not be
 * folded to "Un" or "Us" when they sit inside a shouted name.
 */
const ACRONYMS = new Set([
  "us", "usa", "uk", "un", "eu", "uae", "ksa", "plo", "pa", "idf", "cia", "fbi",
  "nsa", "gcc", "imf", "who", "ilo", "bbc", "cnn", "nyt", "ai", "nato", "opec",
  "isis", "isil", "irgc", "pkk", "sdf", "ypg", "fsa", "pyd", "kdp", "puk", "mbs",
  "mbz", "rcmp", "csis", "ndp", "gop", "dnc", "rnc", "usmca", "nafta", "wto",
  "wef", "oecd", "iaea", "unrwa", "unhcr", "unsc", "unga", "icj", "icc", "ii", "iii", "iv",
]);

/**
 * Folds a name written entirely in capitals to title case.
 *
 * Twenty-one headings in the library were shouted — "WILLIAM SCHABAS" — because
 * the scorer only penalised the form, and when every form a source uses is
 * capitals the penalty chooses nothing. Folding happens before scoring, so the
 * shouted form is never a candidate at all.
 *
 * A single all-caps word that is not a person is left alone: "UNESCO" and
 * "UNRWA" are five letters and not shouting. Inside a longer name, words on the
 * acronym list keep their capitals and particles go lower-case, so
 * "ABDULLAH AL-SAUD" becomes "Abdullah al-Saud" and "UN SECURITY COUNCIL"
 * becomes "UN Security Council".
 */
export function foldShouting(name: string, type: string): string {
  const trimmed = name.trim();
  const letters = trimmed.replace(/[^\p{L}]/gu, "");
  if (letters.length <= 4 || !isShouted(trimmed)) return trimmed;

  const words = trimmed.split(/\s+/);
  if (words.length === 1 && type !== "person") return trimmed;

  return words
    .map((word, i) =>
      word
        .split(/([-'’])/)
        .map((piece, j, all) => {
          if (!/\p{L}/u.test(piece)) return piece;
          const lower = piece.toLowerCase();
          if (ACRONYMS.has(lower)) return piece.toUpperCase();
          // A particle is lower-cased except at the very start of the name.
          // Only the first piece of a hyphenated word counts: the "al" of
          // "al-Saud" is a particle, the "Saud" is not.
          const first = i === 0 && j === 0;
          if (!first && j === 0 && PARTICLES.has(lower)) return lower;
          // After an apostrophe the capital returns only for the Irish and
          // French pattern of a single letter before it: "O'BRIEN" → "O'Brien",
          // "D'SOUZA" → "D'Souza", but "SA'AD" → "Sa'ad".
          if (j >= 2 && all[j - 1] !== "-" && all[j - 2].length > 1) return lower;
          return lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join("")
    )
    .join(" ");
}

/**
 * Scores a candidate name. Higher is a better heading.
 *
 * Only compares forms of the same name — the caller has already established
 * these are all one entity — so this is about presentation, not identity.
 */
function score(name: string, type: string): number {
  const trimmed = name.trim();
  if (!trimmed) return -Infinity;

  const words = trimmed.split(/\s+/).length;
  let s = 0;

  // More of the name is better, but with diminishing returns: a full name beats
  // a surname, while a whole descriptive clause is not a name at all.
  s += Math.min(words, 4) * 10;
  if (words > 6) s -= (words - 6) * 12;

  if (type === "person") {
    if (startsWithTitle(trimmed)) s -= 30;
    if (isInverted(trimmed)) s -= 25;
    // A lone first or last name is usually a fragment of a fuller one.
    if (words === 1) s -= 15;
  }

  if (isShouted(trimmed)) s -= 20;
  // Prefer the form that reads like prose over one carrying stray punctuation.
  if (/[_|/\\<>{}[\]]/.test(trimmed)) s -= 15;
  // Latin script is what the rest of the interface is in; a transliteration is
  // a better heading than a name in a script the reader may not have asked for.
  if (/^[\p{Script=Latin}\p{N}\p{P}\s]+$/u.test(trimmed)) s += 4;

  // Between two names that are otherwise equal — "Chris Donahue" against
  // "Christopher Donahue" — prefer the unabbreviated one. Deliberately tiny, so
  // it only ever settles a tie and never outweighs a real signal.
  s += Math.min(trimmed.length, 40) / 100;

  return s;
}

/**
 * Removes a date range carried inside the name itself.
 *
 * "Second Intifada (2000–2008)" is a heading that settles a question the library
 * has not settled. The contradictions table records, from these very sources,
 * that the end date is disputed — one account says 2005 — so the entity was
 * announcing one side of a disagreement its own entry goes on to report. The
 * same held for "First Intifada (1987–93)".
 *
 * A name is for identifying the thing; dates belong in the disambiguator, where
 * they can be qualified, or in the entry, where they can be cited. Stripped only
 * when something is left over: an entity genuinely called "1948" keeps its name.
 */
export function stripDateSuffix(name: string): string {
  const m = name
    .trim()
    .match(/^(.*\S)\s*\(\s*(?:c\.|circa|ca\.)?\s*\d{3,4}\s*(?:[–—−-]\s*(?:\d{2,4}|present|now))?\s*\)$/i);
  return m ? m[1].trim() : name.trim();
}

/**
 * Picks the best display name from everything we know an entity is called.
 * Returns null when the current name is already the best, so callers can skip
 * a pointless write.
 */
export function bestName(current: string, aliases: string[], type: string): string | null {
  // Shouted forms are folded before they compete, so a name only ever seen in
  // capitals still ends up with a readable heading.
  const candidates = [...new Set([current, ...aliases].map((a) => foldShouting(a, type)))].filter(
    (a) => a.trim()
  );
  // Even a single known form can be improved: a source that only ever says
  // "Dr. Caryl Haskins" should still give an entry headed by the name.
  if (candidates.length === 0) return null;

  let best = foldShouting(current, type);
  let bestScore = score(best, type);

  for (const c of candidates) {
    const s = score(c, type);
    // Ties go to the incumbent, so names do not churn between equal options.
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }

  const trimmed = strip(best, type);
  return trimmed === current ? null : trimmed;
}

/**
 * Removes a leading rank from the chosen name.
 *
 * Sometimes every form we have carries one — a source may only ever say
 * "Dr. Deborah Birx". The heading should still read as a name, so the rank
 * comes off, but only when at least a given and family name remain: stripping
 * "General Donahue" down to "Donahue" would lose more than it gains, and the
 * alias list keeps the titled form either way.
 */
function strip(name: string, type: string): string {
  const name2 = stripDateSuffix(name);
  if (type !== "person") return name2;
  name = name2;
  let words = stripLeadingTitles(name.trim().split(/\s+/), 2);
  // The shared stripper carries the phrases; this list has a few single words
  // of its own ("ambassador", "chancellor") that the match key never needed.
  while (words.length > 2 && TITLE_WORDS.has(words[0].toLowerCase())) words = words.slice(1);
  return words.join(" ");
}
