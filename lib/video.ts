/**
 * Pure video-URL arithmetic, with no dependencies at all.
 *
 * Kept apart from lib/youtube.ts on purpose. That module opens the database to
 * store what it fetches, and the moment a `"use client"` component imports
 * anything from it, webpack follows the chain to better-sqlite3 and the build
 * fails on `Can't resolve 'fs'`. This is the same one-way boundary that sent
 * `dirOf` to lib/dir.ts: a helper both sides need must live somewhere neutral.
 */

/** The video id out of any of the shapes a YouTube link comes in. */
export function videoId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");

    if (host === "youtu.be") return clean(u.pathname.slice(1));
    if (!host.endsWith("youtube.com") && !host.endsWith("youtube-nocookie.com")) return null;

    const v = u.searchParams.get("v");
    if (v) return clean(v);

    // /embed/ID, /shorts/ID, /live/ID, /v/ID
    const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname);
    return m ? clean(m[1]) : null;
  } catch {
    return null;
  }
}

function clean(id: string): string | null {
  const trimmed = id.trim();
  return /^[A-Za-z0-9_-]{6,20}$/.test(trimmed) ? trimmed : null;
}

/**
 * The still. `hqdefault` rather than `maxresdefault` on purpose: maxres exists
 * only for videos uploaded above a certain resolution and 404s silently for the
 * rest, which is how you end up with a shelf of blank rectangles.
 */
export function thumbnailUrl(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

export function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}
