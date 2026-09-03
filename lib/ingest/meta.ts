/**
 * Pure helpers for what a source says about itself: where it was published,
 * when, and under which address. No I/O, so they can be tested without a
 * network and reused by the feed poller when it arrives.
 */

/** Query parameters that identify a click, not a page. */
const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|mkt_tok|ref_src|ref_url|cmpid|s_kwcid|ncid|ocid|oly_enc_id|oly_anon_id|vero_id|_ga|_gl)$/i;

/**
 * The address two feeds carrying the same story are matched on.
 *
 * A page's own rel=canonical wins when it is a usable http(s) address on any
 * host: publishers use it to point syndicated copies back at the original,
 * which is exactly the identity wanted here. Otherwise the URL is cleaned:
 * tracking parameters and the fragment dropped, host lower-cased, default
 * port removed, trailing slash on a path removed. Returns null for anything
 * that is not an http(s) URL.
 */
export function canonicalUrl(url: string, declared?: string | null): string | null {
  const base = parse(url);
  if (!base) return null;

  if (declared?.trim()) {
    try {
      const d = new URL(declared.trim(), base);
      if (d.protocol === "http:" || d.protocol === "https:") return tidy(d);
    } catch {
      /* fall through to the cleaned URL */
    }
  }
  return tidy(base);
}

function parse(url: string): URL | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function tidy(u: URL): string {
  const out = new URL(u.toString());
  out.hash = "";
  out.hostname = out.hostname.toLowerCase();
  out.username = "";
  out.password = "";

  const keep = new URLSearchParams();
  for (const [k, v] of out.searchParams) if (!TRACKING_PARAMS.test(k)) keep.append(k, v);
  keep.sort();
  out.search = keep.toString() ? `?${keep.toString()}` : "";

  if (out.pathname.length > 1 && out.pathname.endsWith("/")) {
    out.pathname = out.pathname.replace(/\/+$/, "");
  }
  return out.toString();
}

/**
 * A language code as a BCP-47 primary tag: "En" → "en", "eng" → "en",
 * "en-US" → "en", "ar-EG" → "ar". Anything unrecognisable becomes null rather
 * than a new spelling of an old value.
 */
export function normaliseLang(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const primary = lang.trim().toLowerCase().split(/[-_]/)[0].replace(/[^a-z]/g, "");
  if (!primary) return null;
  if (primary.length === 2) return primary;
  if (primary.length === 3) return ISO_639_2[primary] ?? primary;
  // "english", "arabic" — an EPUB will occasionally spell it out.
  return BY_NAME[primary] ?? null;
}

const ISO_639_2: Record<string, string> = {
  eng: "en", ara: "ar", fra: "fr", fre: "fr", deu: "de", ger: "de", spa: "es",
  ita: "it", por: "pt", rus: "ru", tur: "tr", fas: "fa", per: "fa", heb: "he",
  urd: "ur", hin: "hi", zho: "zh", chi: "zh", jpn: "ja", kor: "ko", nld: "nl",
  dut: "nl", swe: "sv", pol: "pl", ukr: "uk", ell: "el", gre: "el", kur: "ku",
};

const BY_NAME: Record<string, string> = {
  english: "en", arabic: "ar", french: "fr", german: "de", spanish: "es",
  italian: "it", portuguese: "pt", russian: "ru", turkish: "tr", persian: "fa",
  farsi: "fa", hebrew: "he", urdu: "ur", hindi: "hi", chinese: "zh",
  japanese: "ja", korean: "ko", dutch: "nl",
};

/**
 * A publication date as a full ISO datetime, or null when the input cannot be
 * read as one. Date-only inputs are kept date-only ("2026-09-01") so a book's
 * bare year does not gain a fictitious midnight.
 */
export function toPublishedAt(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}$/.test(s)) return s;
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(s)) return s;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

/** The host without a leading "www.", used as the outlet when a page declares no name. */
export function outletFromUrl(url: string): string | null {
  const u = parse(url);
  if (!u) return null;
  return u.hostname.toLowerCase().replace(/^www\./, "") || null;
}
