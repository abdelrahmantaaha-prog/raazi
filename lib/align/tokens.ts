/**
 * Word normalisation and light stemming, for comparison only.
 *
 * Ported from Mutarjim's `lib/term-match.ts`, which is where this alignment
 * came from. Only the two functions the lexicon needs: Corpus has no glossary
 * or translation memory to carry the rest of that module over for.
 *
 * Exact word-boundary matching misses most real correspondences — English
 * inflects (warranty / warranties / warranted) and Arabic wears clitics
 * (ضمان / الضمان / بالضمانات). Light stemming on both sides closes that gap;
 * anything deeper starts merging unrelated words.
 *
 * Stored text is never altered by any of this.
 */

/** Lowercase, drop Arabic diacritics and tatweel, unify alef and alef maqsura. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/<\/?(?:sup|sub|[bius])>/g, "")
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[آأإٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

const AR_PREFIXES = ["وال", "بال", "كال", "فال", "لل", "ال", "و", "ف", "ب", "ل", "ك", "س"];
const AR_SUFFIXES = ["هما", "كما", "تين", "ات", "ان", "ين", "ون", "ها", "هم", "هن", "كم", "نا", "ه", "ك", "ي", "ة", "ت"];

function isArabic(tok: string): boolean {
  return /[؀-ۿ]/.test(tok);
}

/** Light stem of one normalised token: clitics and common inflection only. */
export function stemToken(tok: string): string {
  if (isArabic(tok)) {
    let t = tok;
    for (const p of AR_PREFIXES) {
      if (t.length - p.length >= 3 && t.startsWith(p)) {
        t = t.slice(p.length);
        break;
      }
    }
    for (const s of AR_SUFFIXES) {
      if (t.length - s.length >= 3 && t.endsWith(s)) {
        t = t.slice(0, -s.length);
        break;
      }
    }
    return t;
  }
  let t = tok.replace(/['’]s$/, "");
  if (t.length >= 5 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  for (const s of ["ing", "ed", "es", "s"]) {
    if (t.length - s.length >= 3 && t.endsWith(s)) {
      t = t.slice(0, -s.length);
      break;
    }
  }
  if (t.length >= 4 && t.endsWith("e")) t = t.slice(0, -1);
  return t;
}
