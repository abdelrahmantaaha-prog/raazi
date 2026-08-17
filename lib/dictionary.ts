import { db } from "./db";

/**
 * Word lookup for the reader.
 *
 * Wiktionary rather than a dictionary API, because it needs no key and no
 * account, and because it defines Arabic — an English-only dictionary would be
 * useless against half this library.
 *
 * Always the *English* Wiktionary, whatever the word. The obvious design was to
 * ask ar.wiktionary.org about Arabic words, and it does not work: the REST
 * definition endpoint is an English-Wiktionary feature and every other edition
 * answers 501 Not Implemented. English Wiktionary, meanwhile, has extensive
 * Arabic coverage, returned under an "other" key and tagged by language. So one
 * endpoint serves both, and the language of each sense is shown rather than
 * assumed — useful in itself, since it distinguishes Modern Standard Arabic
 * from Hijazi or Egyptian.
 *
 * Costs no tokens. A dictionary that phoned a language model to define "polity"
 * would be a strange thing to build and an expensive thing to use, and the
 * definitions would be less trustworthy, not more.
 *
 * Answers are cached in the database forever. Words do not change often, and a
 * reader who looks up the same word twice on facing pages should not wait for
 * the network twice.
 */

export interface Sense {
  partOfSpeech: string;
  /** "Arabic", "Egyptian Arabic", "English" — which language this sense is of. */
  language: string;
  definitions: string[];
}

export interface Definition {
  word: string;
  /** The language the word was taken to be in. */
  lang: string;
  senses: Sense[];
  url: string;
  /**
   * True when the definitions are written in the word's own language — an
   * Arabic word explained in Arabic, rather than glossed into English. Worth
   * surfacing: the two are different things to read, and only one of them is a
   * dictionary of the language you are reading.
   */
  native: boolean;
}

/** Which language's senses to prefer, from the shape of the word itself. */
export function editionFor(word: string): "ar" | "en" {
  return /[؀-ۿݐ-ݿ]/.test(word) ? "ar" : "en";
}

const LANGUAGE_NAME: Record<string, string> = { ar: "Arabic", en: "English" };

/**
 * Strips what a selection picks up but a dictionary cannot use: surrounding
 * punctuation, quote marks, and Arabic diacritics, which are written
 * inconsistently and are almost never present in Wiktionary's headwords.
 */
export function normaliseWord(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim();
}

function cached(word: string, lang: string): Definition | null {
  const row = db()
    .prepare("SELECT json FROM dictionary WHERE word=? AND lang=?")
    .get(word, lang) as { json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.json) as Definition;
  } catch {
    return null;
  }
}

function remember(word: string, lang: string, def: Definition | null): void {
  db()
    .prepare(
      `INSERT INTO dictionary (word, lang, json) VALUES (?, ?, ?)
         ON CONFLICT(word, lang) DO UPDATE SET json=excluded.json`
    )
    .run(word, lang, JSON.stringify(def));
}

interface WiktionaryEntry {
  partOfSpeech?: string;
  language?: string;
  definitions?: { definition?: string; examples?: string[] }[];
}

/**
 * Looks a word up, cache first.
 *
 * A miss is cached too, as `null`. Otherwise every scroll past an unusual
 * proper noun re-asks Wikimedia about a word it has already said it does not
 * have.
 */
export async function define(rawWord: string, hintLang?: string): Promise<Definition | null> {
  const word = normaliseWord(rawWord);
  if (!word || word.length > 60) return null;

  const lang = hintLang === "ar" || hintLang === "en" ? hintLang : editionFor(word);

  const hit = cached(word, lang);
  if (hit !== null) return hit;
  // A stored null is a remembered miss, which `cached` cannot distinguish from
  // "never asked" — so check for the row itself before going to the network.
  const asked = db()
    .prepare("SELECT 1 AS x FROM dictionary WHERE word=? AND lang=?")
    .get(word, lang);
  if (asked) return null;

  // An Arabic word gets an Arabic dictionary first. Falling straight to the
  // English Wiktionary would answer a different question — what does this word
  // translate to — when the one being asked is what it means.
  const def = lang === "ar" ? ((await arabic(word)) ?? (await english(word, "ar"))) : await english(word, "en");

  remember(word, lang, def);
  return def;
}

/**
 * The Arabic Wiktionary, in Arabic.
 *
 * Three things had to be worked out to make this usable, none of them obvious:
 *
 *   - the REST `page/definition` endpoint that serves the English Wiktionary
 *     answers 501 here, and on every edition but English. The old MediaWiki
 *     Action API does work, everywhere.
 *   - `prop=extracts` returns almost nothing, because it strips templates and a
 *     Wiktionary page is mostly templates. `action=parse` returns the rendered
 *     page, where the definitions are plain list items.
 *   - headwords are stored fully vowelled — سِيَاسَة, not سياسة — and the bare
 *     spelling is a redirect, or a disambiguation page listing the vowelled
 *     forms. Both have to be followed or most lookups find nothing.
 */
async function arabic(word: string): Promise<Definition | null> {
  const page = await parsePage(word);
  if (!page) return null;

  // A bare spelling often lands on a list of the vowelled forms it could be.
  //
  // Every one is tried, not just the first: حرب offers حَرَبَ before حَرْب, and
  // the first is a verb page with no definitions on it while the second is the
  // noun everybody means by the word. Stopping at the first found nothing and
  // fell through to an English gloss of the wrong sense.
  if (/قائمة توضيح|صفحة توضيح/.test(page.html)) {
    for (const variant of variantsOf(page.html, word)) {
      const followed = await parsePage(variant);
      const def = followed ? fromArabicPage(followed.title, followed.html) : null;
      if (def) return def;
    }
    return null;
  }

  return fromArabicPage(page.title, page.html);
}

/**
 * Wikimedia throttles bursts, and a throttled request is indistinguishable
 * from a word it does not have — which is the worst way to fail here, because
 * it silently downgrades a native Arabic definition to an English gloss.
 *
 * Half a second between requests is far below anything a person reading a book
 * would produce and enough to stay welcome. Only this path is paced; the
 * English endpoint is a different service and has not complained.
 */
const MIN_GAP_MS = 500;
let lastCall = 0;

async function pace(): Promise<void> {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

async function parsePage(title: string): Promise<{ title: string; html: string } | null> {
  await pace();
  const url =
    `https://ar.wiktionary.org/w/api.php?action=parse&format=json&formatversion=2` +
    `&redirects=1&prop=text&page=${encodeURIComponent(title)}`;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Corpus/0.1 (personal research reader)" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      error?: { code: string };
      parse?: { title: string; text: string };
    };
    if (data.error || !data.parse?.text) return null;
    return { title: data.parse.title, html: data.parse.text };
  } catch {
    return null;
  }
}

/** The vowelled headwords a disambiguation page points at. Capped, so a long
 *  list cannot turn one lookup into a dozen requests. */
function variantsOf(html: string, bare: string): string[] {
  const strip = (s: string) => s.replace(/[ً-ْٰـ]/g, "");
  const links = [...html.matchAll(/<a[^>]+title="([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(links.filter((t) => strip(t) === bare && t !== bare))].slice(0, 4);
}

/**
 * The senses out of a rendered Arabic Wiktionary page.
 *
 * Definitions are list items; everything else on the page — conjugation
 * tables, translations, etymology — is not, which makes the extraction simple
 * and the result exactly what a reader wants. Translation lists are the one
 * exception, and they sit under headings this stops at.
 */
function fromArabicPage(title: string, html: string): Definition | null {
  // Cut everything from the translations heading onwards: those are lists of
  // the word in forty languages, not definitions of it.
  const stop = html.search(/id="(ترجمات|انظر_كذلك|مراجع)"/);
  const body = stop > 0 ? html.slice(0, stop) : html;

  const definitions = [...body.matchAll(/<li>([\s\S]*?)<\/li>/g)]
    .map((m) => stripMarkup(m[1]))
    .filter((t) => t.length > 8 && !/^\d+$/.test(t))
    .slice(0, 6);

  if (!definitions.length) return null;

  return {
    word: title,
    lang: "ar",
    senses: [{ partOfSpeech: "", language: "العربية", definitions }],
    url: `https://ar.wiktionary.org/wiki/${encodeURIComponent(title)}`,
    native: true,
  };
}

/**
 * The English Wiktionary, which defines Arabic words in English.
 *
 * Kept as the fallback rather than the first answer: it has far wider coverage
 * than the Arabic edition, so it catches what that misses, but a gloss is not a
 * definition and the reader is told which one they are looking at.
 */
async function english(word: string, want: "ar" | "en"): Promise<Definition | null> {
  const url = `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`;

  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Corpus/0.1 (personal research reader)" },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as Record<string, WiktionaryEntry[]>;
    const wanted = LANGUAGE_NAME[want];

    // The response is keyed inconsistently: some languages get their own code
    // as a key ("ar", "arz"), the rest are lumped under "other", and only the
    // per-entry `language` field is reliable. Reading `other` alone missed
    // every Modern Standard Arabic entry in the library, because those sit
    // under "ar". So every key is pooled and the entries themselves are asked
    // what language they are.
    const pool = Object.values(data).flat();

    // Exact language first: plain "Arabic" before "Egyptian Arabic", so a
    // Modern Standard reading is not buried under four dialects.
    const ordered = pool
      .filter((e) => score(e.language, wanted) > 0)
      .sort((a, b) => score(b.language, wanted) - score(a.language, wanted));

    const senses: Sense[] = ordered
      .map((e) => ({
        partOfSpeech: e.partOfSpeech ?? "",
        language: e.language ?? wanted,
        definitions: (e.definitions ?? [])
          .map((d) => stripMarkup(d.definition ?? ""))
          .filter(Boolean)
          .slice(0, 4),
      }))
      .filter((s) => s.definitions.length > 0)
      .slice(0, 4);

    if (senses.length === 0) return null;

    return {
      word,
      lang: want,
      senses,
      url: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`,
      // English defining English is native; English defining Arabic is a gloss.
      native: want === "en",
    };
  } catch {
    // A network failure is not a fact about the word, so it is not cached.
    return null;
  }
}

function score(language: string | undefined, wanted: string): number {
  return language === wanted ? 2 : (language ?? "").includes(wanted) ? 1 : 0;
}

/** Wiktionary returns definitions as HTML fragments; the reader wants text. */
function stripMarkup(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
