import { db } from "./db";
import { thumbnailUrl, videoId, watchUrl } from "./video";

export { thumbnailUrl, videoId, watchUrl } from "./video";

/**
 * What YouTube will tell you without an API key.
 *
 * Two endpoints, both public and both unauthenticated: oEmbed gives the title
 * and the channel, and the thumbnail is a predictable URL. That is the whole
 * of it — no key to manage, no quota to exhaust, nothing to configure before a
 * pasted link becomes a titled, illustrated row on the shelf.
 *
 * Anything beyond this (view counts, descriptions, durations) needs the Data
 * API and therefore a key, and none of it would change what the shelf shows.
 */

export interface VideoMeta {
  id: string;
  title: string;
  channel: string | null;
  thumbnail: string;
}

/** Title and channel, via oEmbed. Null when the video is private or gone. */
export async function lookup(url: string): Promise<VideoMeta | null> {
  const id = videoId(url);
  if (!id) return null;

  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl(id))}&format=json`,
      { headers: { "user-agent": "Raazi/0.1 (personal research)" } }
    );
    if (!res.ok) return null;

    const data = (await res.json()) as { title?: string; author_name?: string };
    if (!data.title) return null;

    return {
      id,
      title: data.title,
      channel: data.author_name ?? null,
      thumbnail: thumbnailUrl(id),
    };
  } catch {
    return null;
  }
}

/**
 * Fills in a YouTube source's real title and channel, once.
 *
 * A pasted link is stored with the URL as its title, because the alternative is
 * making you wait on a network call before the source exists at all. This is
 * the other half of that bargain, and it is deliberately conservative: it only
 * overwrites a title that is still literally the URL, so a title you typed
 * yourself is never replaced by the channel's.
 */
export async function fillMeta(sourceId: number): Promise<VideoMeta | null> {
  const row = db().prepare("SELECT id, title, author, url FROM sources WHERE id=?").get(sourceId) as
    | { id: number; title: string; author: string | null; url: string | null }
    | undefined;
  if (!row?.url) return null;

  const meta = await lookup(row.url);
  if (!meta) return null;

  const titleIsPlaceholder = row.title.trim() === row.url.trim() || !row.title.trim();

  db()
    .prepare(
      `UPDATE sources
          SET title  = CASE WHEN ? THEN ? ELSE title END,
              author = COALESCE(author, ?),
              publisher = COALESCE(publisher, 'YouTube')
        WHERE id = ?`
    )
    .run(titleIsPlaceholder ? 1 : 0, meta.title, meta.channel, sourceId);

  return meta;
}
