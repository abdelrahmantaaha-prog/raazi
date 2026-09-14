import { db } from "./db";
import { wordCount } from "./triage";

/**
 * Articles starred for a closer look.
 *
 * The inbox is for deciding quickly, and some pieces deserve more than the two
 * seconds a headline gets: a long analysis, a document worth reading line by
 * line, something you may write about. A star sets one aside without deciding
 * anything. The article stays wherever it is — waiting, kept, filed, or
 * discarded, whose text is kept on disk regardless — and the Write page lists
 * everything starred beside the drafts it may end up in.
 *
 * The mark lives on the source, not the feed item, so it outlasts whatever
 * happens to the item in the inbox.
 */

export interface StarredArticle {
  id: number;
  title: string;
  url: string | null;
  outlet: string | null;
  author: string | null;
  published_at: string | null;
  starred_at: string;
  /** The source's own triage word: held, kept, filed, discarded, or null for a library source. */
  triage: string | null;
  /** The inbox item it arrived as, when it arrived through the inbox. */
  item_id: number | null;
  item_state: string | null;
  image: string | null;
  /** The opening of the article, for recognising it at a glance. */
  lede: string | null;
  words: number;
  chars: number;
}

/** Everything starred, most recently starred first. */
export function listStarred(): StarredArticle[] {
  const rows = db()
    .prepare(
      `SELECT s.id, s.title, s.url, s.outlet, s.author, s.published_at, s.starred_at, s.triage,
              i.id AS item_id, i.state AS item_state,
              COALESCE(i.image_url, json_extract(s.meta_json, '$.image')) AS image,
              (SELECT c.text FROM chunks c WHERE c.source_id = s.id ORDER BY c.seq LIMIT 1) AS lede
         FROM sources s
    LEFT JOIN feed_items i ON i.id = (SELECT MAX(f.id) FROM feed_items f WHERE f.source_id = s.id)
        WHERE s.starred_at IS NOT NULL
        ORDER BY s.starred_at DESC, s.id DESC`
    )
    .all() as Omit<StarredArticle, "words" | "chars">[];

  const texts = db().prepare("SELECT text FROM chunks WHERE source_id = ?");
  return rows.map((r) => {
    const passages = texts.all(r.id) as { text: string }[];
    return {
      ...r,
      lede: r.lede ? r.lede.replace(/\s+/g, " ").trim().slice(0, 400) : null,
      chars: passages.reduce((n, p) => n + p.text.length, 0),
      words: passages.reduce((n, p) => n + wordCount(p.text), 0),
    };
  });
}

/**
 * Stars or unstars a source. False when there is no such source.
 *
 * Starring something already starred keeps the time it was first starred, so
 * the list's order is the order you set things aside in.
 */
export function setStarred(sourceId: number, starred: boolean): boolean {
  const result = db()
    .prepare(
      starred
        ? "UPDATE sources SET starred_at = COALESCE(starred_at, datetime('now')) WHERE id = ?"
        : "UPDATE sources SET starred_at = NULL WHERE id = ?"
    )
    .run(sourceId);
  return result.changes > 0;
}
