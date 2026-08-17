/**
 * Match keys for entity resolution. "Dr. Gamal Abdel-Nasser" and
 * "gamal abdel nasser" have to collapse to the same string, or the pedia ends
 * up with three entries for one man. Everything here is cheap and local — the
 * expensive LLM adjudication only sees what survives this.
 */

const HONORIFICS = [
  "dr", "prof", "professor", "mr", "mrs", "ms", "miss", "sir", "lord", "lady",
  "rev", "fr", "st", "saint", "president", "king", "queen", "prince", "princess",
  "sheikh", "shaykh", "sheik", "imam", "hajj", "haj", "sayyid", "general",
  "colonel", "captain", "major", "senator", "governor", "minister", "sultan",
  "emir", "amir", "pasha", "bey",
];

const ARABIC_HONORIFICS = [
  "الدكتور", "الدكتورة", "الأستاذ", "الأستاذة", "السيد", "السيدة", "الشيخ",
  "الشيخة", "الملك", "الملكة", "الأمير", "الأميرة", "الرئيس", "الوزير",
  "اللواء", "العميد", "المهندس", "الحاج", "السلطان",
];

const ORG_SUFFIXES = [
  "inc", "incorporated", "corp", "corporation", "ltd", "limited", "llc", "plc",
  "gmbh", "sa", "sarl", "co", "company", "group", "holdings", "holding",
];

/**
 * Arabic letter folding: alef forms, ya/alef maqsura, ta marbuta, diacritics.
 * Note this runs over the honorific lists too — otherwise "الرئيس" folds to
 * "الرييس" and never matches the entry we were comparing it against.
 */
function foldArabic(s: string): string {
  return s
    .replace(/[ً-ْٰـ]/g, "") // harakat, dagger alef, tatweel
    .replace(/[آأإٱ]/g, "ا") // آ أ إ ٱ -> ا
    .replace(/ى/g, "ي") // ى -> ي
    .replace(/ة/g, "ه") // ة -> ه
    .replace(/[ؤ]/g, "و") // ؤ -> و
    .replace(/[ئ]/g, "ي"); // ئ -> ي
}

/**
 * Titles that are more than one word.
 *
 * Stripping word by word cannot reach these: "minister" is in the single-word
 * list, but it is the *second* word of "Prime Minister Netanyahu", so the name
 * kept its rank — which cost the match key, the display name, and every lookup
 * that goes out to the wider world. Wikidata finds nothing at all for "Prime
 * Minister Netanyahu" and the right person instantly for "Netanyahu".
 */
const TITLE_PHRASES = [
  "prime minister", "deputy prime minister", "vice president", "vice-president",
  "foreign minister", "defence minister", "defense minister", "finance minister",
  "interior minister", "justice minister", "chief of staff", "attorney general",
  "secretary of state", "secretary general", "secretary-general", "crown prince",
  "crown princess", "grand ayatollah", "field marshal", "lieutenant general",
  "major general", "brigadier general", "chief justice", "supreme leader",
  "chief rabbi", "chief executive", "first lady", "his excellency",
  "her excellency", "his majesty", "her majesty", "his holiness",
  "united states president", "us president", "un secretary general",
];

const ARABIC_TITLE_PHRASES = [
  "رئيس الوزراء", "ولي العهد", "وزير الخارجية", "وزير الدفاع", "وزير الداخلية",
  "رئيس الأركان", "المرشد الأعلى", "رئيس الجمهورية", "نائب الرئيس", "قائد الجيش",
];

/** The title lists have to sit in the same folded space as the input they are
 *  matched against, so they go through the same folding at load. */
const TITLES = new Set([...HONORIFICS, ...ARABIC_HONORIFICS.map(foldArabic)]);
const ORG_SUFFIX_SET = new Set(ORG_SUFFIXES);

/** Longest first, so "deputy prime minister" is not eaten by "prime minister". */
const PHRASES: string[][] = [...TITLE_PHRASES, ...ARABIC_TITLE_PHRASES.map(foldArabic)]
  .map((p) => p.split(" "))
  .sort((a, b) => b.length - a.length);

/** The same folded, lower-cased space the title lists live in. */
const fold = (word: string) =>
  foldArabic(word.normalize("NFKC").toLowerCase())
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.,]/g, "");

/**
 * Removes leading titles — single words and phrases, however many are stacked —
 * while leaving at least `minKeep` words behind.
 *
 * Shared so the match key and the display name strip the same things. They
 * used to keep separate lists, which is how "Prime Minister" survived in one
 * and not the other.
 */
export function stripLeadingTitles(words: string[], minKeep: number): string[] {
  let out = words;
  for (let guard = 0; guard < 6; guard++) {
    const folded = out.map(fold);

    const phrase = PHRASES.find(
      (p) =>
        out.length - p.length >= minKeep &&
        p.every((word, i) => folded[i] === word)
    );
    if (phrase) {
      out = out.slice(phrase.length);
      continue;
    }
    if (out.length > minKeep && TITLES.has(folded[0])) {
      out = out.slice(1);
      continue;
    }
    return out;
  }
  return out;
}

/**
 * Titles are stripped only for people.
 *
 * "General" is a rank in front of a person and the first word of a company —
 * stripping it everywhere turned General Motors into "motors", General Electric
 * into "electric" and King Fahd University into "fahd university", which is
 * both wrong and a collision risk. The entity's own type is the only thing that
 * can tell those apart, so it has to be passed in.
 */
export function normalize(raw: string, type?: string): string {
  let s = raw.normalize("NFKC").trim();

  s = foldArabic(s);
  // Strip Latin diacritics: é -> e
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  s = s.toLowerCase();

  // Definite articles and possessives that vary by sentence position.
  s = s.replace(/^(the|a|an)\s+/i, "");
  s = s.replace(/['’]s\b/g, "");

  // Punctuation to spaces, so "Abdel-Nasser" == "Abdel Nasser".
  s = s.replace(/[.,;:!?"“”'’()\[\]{}<>/\\|_+*&%$#@~`^=-]/g, " ");

  let words = s.split(/\s+/).filter(Boolean);

  // Leading titles, however many are stacked ("His Excellency Dr. …"), but
  // only on a person. An organisation keeps every word of its name.
  if (type === undefined || type === "person") {
    words = stripLeadingTitles(words, 1);
  }
  // Trailing corporate boilerplate.
  while (words.length > 1 && ORG_SUFFIX_SET.has(words[words.length - 1])) {
    words = words.slice(0, -1);
  }

  return words.join(" ");
}

/** A rough "is this the same name" score in [0,1], from character trigrams. */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (s: string) => {
    const padded = `  ${s} `;
    const out = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return shared / (ga.size + gb.size - shared);
}

/**
 * True when one name is a prefix/suffix subset of the other — "Nasser" inside
 * "Gamal Abdel Nasser". A strong hint, but never proof on its own: plenty of
 * books contain more than one Nasser.
 */
export function isSubsetName(a: string, b: string): boolean {
  const wa = a.split(" ").filter(Boolean);
  const wb = b.split(" ").filter(Boolean);
  if (wa.length === 0 || wb.length === 0 || wa.length === wb.length) return false;
  const [short, long] = wa.length < wb.length ? [wa, wb] : [wb, wa];
  return short.every((w) => long.includes(w));
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Buffer | null): Float32Array | null {
  if (!b || b.length === 0) return null;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
