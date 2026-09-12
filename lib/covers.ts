import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, db } from "./db";
import { safeFetch } from "./net";
import { fillMeta, thumbnailUrl, videoId } from "./youtube";

/**
 * Cover art for the shelf.
 *
 * Looked up once against Open Library and then kept on disk, so the Library
 * page does not hit the network on every render and still works with no
 * connection. A miss is remembered too — otherwise every page load would
 * re-ask about the same obscure PDF.
 *
 * Open Library needs no key and no account.
 */

export const COVERS_DIR = path.join(DATA_DIR, "covers");

interface CoverState {
  /** "hit" with a file, "miss" if nothing was found, absent if never asked. */
  cover?: "hit" | "miss";
  coverAt?: string;
  /** Where a web source's own image came from, when it had one. */
  image?: string;
  /** Whether YouTube has been asked for this video's title and channel. */
  videoMetaAt?: string;
  /** Whether a pre-YouTube "no cover" verdict has been withdrawn for this one. */
  videoCoverReset?: string;
}

function meta(sourceId: number): CoverState {
  const row = db().prepare("SELECT meta_json FROM sources WHERE id=?").get(sourceId) as
    | { meta_json: string }
    | undefined;
  try {
    return JSON.parse(row?.meta_json ?? "{}") as CoverState;
  } catch {
    return {};
  }
}

function setMeta(sourceId: number, patch: CoverState) {
  const next = { ...meta(sourceId), ...patch };
  db().prepare("UPDATE sources SET meta_json=? WHERE id=?").run(JSON.stringify(next), sourceId);
}

/**
 * Gives a YouTube source its real title and channel, once ever.
 *
 * Separate from cover fetching, and called before it, because the two get out
 * of step: a video added before this existed already has its thumbnail cached,
 * so the cover path returns early and the title work would never run. The
 * shelf would keep showing "https://www.youtube.com/watch?v=BBUmdkGO1_k" for
 * ever. Hence its own flag, and its own place in the request.
 */
export async function ensureVideoMeta(sourceId: number): Promise<void> {
  const row = db().prepare("SELECT title, url FROM sources WHERE id=?").get(sourceId) as
    | { title: string; url: string | null }
    | undefined;
  if (!row?.url || !videoId(row.url)) return;

  const state = meta(sourceId);

  // Two separate one-time jobs, with separate flags on purpose. Sharing one
  // flag means whichever job is added second never runs on the videos already
  // marked done by the first — which is exactly what happened here.

  // 1. Withdraw a "no cover" verdict reached by the old method. Those lookups
  //    scraped the watch page for an og:image, which YouTube does not reliably
  //    serve to a plain fetch, so the miss was about the method rather than the
  //    video. The thumbnail is a URL we can construct, and it always exists.
  if (!state.videoCoverReset) {
    const next: CoverState = { ...state, videoCoverReset: new Date().toISOString() };
    delete next.cover;
    delete next.coverAt;
    db().prepare("UPDATE sources SET meta_json=? WHERE id=?").run(JSON.stringify(next), sourceId);
  }

  // 2. Ask YouTube for the title and channel, once.
  if (state.videoMetaAt) return;
  // Nothing to do for a video you have already titled yourself.
  if (row.title.trim() && row.title.trim() !== row.url.trim()) {
    setMeta(sourceId, { videoMetaAt: new Date().toISOString() });
    return;
  }
  await fillMeta(sourceId);
  setMeta(sourceId, { videoMetaAt: new Date().toISOString() });
}

export function coverPath(sourceId: number): string {
  return path.join(COVERS_DIR, `${sourceId}.jpg`);
}

/** A cover already on disk, or null. Never touches the network. */
export function cachedCover(sourceId: number): string | null {
  const p = coverPath(sourceId);
  return fs.existsSync(p) ? p : null;
}

/** True when we have already looked and found nothing, so don't look again. */
export function knownMiss(sourceId: number): boolean {
  return meta(sourceId).cover === "miss";
}

interface Doc {
  cover_i?: number;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  publisher?: string[];
  isbn?: string[];
}

/**
 * Finds and stores a cover. Returns the path, or null when there is nothing
 * plausible — deliberately conservative, because a confidently wrong cover on
 * a research source is worse than none.
 */
export async function fetchCover(sourceId: number): Promise<string | null> {
  const existing = cachedCover(sourceId);
  if (existing) return existing;
  if (knownMiss(sourceId)) return null;

  const source = db().prepare("SELECT * FROM sources WHERE id=?").get(sourceId) as
    | { id: number; title: string; author: string | null; kind: string; url: string | null }
    | undefined;
  if (!source) return null;

  fs.mkdirSync(COVERS_DIR, { recursive: true });

  try {
    const video = videoId(source.url);
    // An article's picture was usually noted when the page was first read;
    // only a source from before that, or one added by hand, needs the page
    // opened again.
    const remembered = meta(sourceId).image;
    const url = video
      ? thumbnailUrl(video)
      : source.kind === "url" || source.kind === "media"
        ? (remembered ?? (await siteImage(source.url)))
        : await openLibraryCover(source.title, source.author);

    if (!url) {
      setMeta(sourceId, { cover: "miss", coverAt: new Date().toISOString() });
      return null;
    }

    // The image address may be one the fetched page declared, so it is held
    // to the same rule as the page itself: no internal addresses, whatever
    // og:image says.
    const res = await safeFetch(url, { headers: { "user-agent": "Corpus/0.1 (personal research)" } });
    if (!res.ok) throw new Error(`cover fetch ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    // Open Library answers 200 with a 1x1 placeholder when it has nothing.
    if (buf.length < 3000) {
      setMeta(sourceId, { cover: "miss", coverAt: new Date().toISOString() });
      return null;
    }

    await fs.promises.writeFile(coverPath(sourceId), buf);
    setMeta(sourceId, { cover: "hit", coverAt: new Date().toISOString(), image: url });
    return coverPath(sourceId);
  } catch {
    setMeta(sourceId, { cover: "miss", coverAt: new Date().toISOString() });
    return null;
  }
}

/** Titles carry filename residue often enough to be worth cleaning first. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/\.(pdf|epub|txt|md|docx?)$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\b(19|20)\d\d\b/g, " ")
    .replace(/\bz-?lib(rary)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Open Library matches titles literally, so "The Shock Doctrine: The Rise of
 * Disaster Capitalism" finds nothing while "The Shock Doctrine" finds the book.
 * Hence a ladder of progressively shorter queries — but the *match* is always
 * checked against the full title, so shortening only widens the search, never
 * the acceptance.
 */
function queryLadder(title: string): string[] {
  const full = cleanTitle(title);
  const queries = [full];

  const beforeSubtitle = full.split(/\s*[:–—]\s*/)[0].trim();
  if (beforeSubtitle.length >= 6 && beforeSubtitle !== full) queries.push(beforeSubtitle);

  const words = beforeSubtitle.split(" ");
  if (words.length > 6) queries.push(words.slice(0, 6).join(" "));

  return queries;
}

async function openLibraryCover(title: string, author: string | null): Promise<string | null> {
  const wanted = normalise(cleanTitle(title));
  if (wanted.length < 4) return null;

  // An EPUB's author field is often "Klein, Naomi" or a publisher's imprint,
  // neither of which Open Library's author filter will match — so every query
  // is tried with the author and then without it. Title matching stays strict
  // either way, which is what actually guards against a wrong cover.
  const attempts = author?.trim()
    ? queryLadder(title).flatMap((q) => [{ q, a: author.trim() }, { q, a: null }])
    : queryLadder(title).map((q) => ({ q, a: null }));

  for (const { q, a } of attempts) {
    const params = new URLSearchParams({ title: q, limit: "8", fields: "cover_i,title,author_name" });
    if (a) params.set("author", a);

    const res = await fetch(`https://openlibrary.org/search.json?${params}`, {
      headers: { "user-agent": "Corpus/0.1 (personal research)" },
    });
    if (!res.ok) continue;

    const data = (await res.json()) as { docs?: Doc[] };
    const docs = (data.docs ?? []).filter((d) => d.cover_i);
    if (!docs.length) continue;

    // Only accept a result whose title genuinely resembles what we asked for.
    // Open Library returns loosely related books happily, and a confidently
    // wrong cover on a research source is worse than no cover at all.
    const match =
      docs.find((d) => normalise(d.title ?? "") === wanted) ??
      docs.find((d) => {
        const got = normalise(d.title ?? "");
        return got.length >= 6 && (got === wanted || wanted.startsWith(`${got} `) || got.startsWith(`${wanted} `));
      });

    if (match) return `https://covers.openlibrary.org/b/id/${match.cover_i}-L.jpg`;
  }
  return null;
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A web article's own social image, if it declared one. */
async function siteImage(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await safeFetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200_000);
    const m =
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html) ??
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i.exec(html);
    if (!m) return null;
    return new URL(m[1], url).toString();
  } catch {
    return null;
  }
}
