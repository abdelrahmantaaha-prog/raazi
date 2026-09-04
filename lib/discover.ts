import { addUrl } from "./ingest";
import { db } from "./db";
import { alreadyHave, bingNewsQueryUrl, fetchFeed, newsQueryFeedUrl, type FeedItem } from "./feeds";
import { canonicalUrl } from "./ingest/meta";
import { unwrapRedirect } from "./ingest/meta";

/**
 * Searching the news from inside the library, and pulling in what is worth it.
 *
 * A feed is a standing instruction; this is the opposite — a question asked
 * once, about a phrase you are chasing today, with no subscription and nothing
 * kept afterwards unless you say so. It is the same machinery underneath: both
 * search engines answer in RSS, so the parser and the ingest path are the ones
 * already here, and nothing new has to be trusted.
 *
 * Two engines, for one reason. Google News has the better coverage and hands
 * back links only Google can resolve, so what it finds can be listed but often
 * not read. Bing wraps its links too but carries the real address in a query
 * parameter, which unwrapRedirect recovers — so a result from Bing usually
 * opens. Both are searched and the results are merged on the canonical
 * address, which is also how a result you already hold is recognised.
 *
 * No model is involved anywhere here. Searching is free, and pulling an
 * article in is the same act as keeping one from the inbox: you looked at it
 * and said yes, so it goes straight to being read.
 */

export interface Result {
  title: string;
  url: string | null;
  summary: string | null;
  publishedAt: string | null;
  outlet: string | null;
  engine: "google" | "bing";
  /** Readable means the address survived unwrapping — a redirect nobody but
   *  the search engine can resolve is a headline, not a source. */
  readable: boolean;
  /** Already in the library, with the id so the caller can link to it. */
  sourceId: number | null;
}

const ENGINES = {
  google: { url: newsQueryFeedUrl, opaque: "news.google.com" },
  bing: { url: bingNewsQueryUrl, opaque: "bing.com" },
} as const;

export type Engine = keyof typeof ENGINES;

/** Where a result came from, as an outlet name — RSS puts it in the title. */
function outletOf(item: FeedItem): string | null {
  // Both engines append " - Outlet Name" to the headline.
  const m = /\s+-\s+([^-]{2,60})$/.exec(item.title);
  return m ? m[1].trim() : null;
}

function titleOf(item: FeedItem): string {
  return item.title.replace(/\s+-\s+[^-]{2,60}$/, "").trim() || item.title;
}

export async function search(
  query: string,
  opts: { engines?: Engine[]; limit?: number } = {}
): Promise<{ results: Result[]; problems: string[] }> {
  const engines = opts.engines ?? (["google", "bing"] as Engine[]);
  const limit = opts.limit ?? 40;
  const problems: string[] = [];
  const byKey = new Map<string, Result>();

  for (const engine of engines) {
    let parsed;
    try {
      const got = await fetchFeed({ url: ENGINES[engine].url(query), etag: null, last_modified: null });
      parsed = got.parsed;
    } catch (err) {
      problems.push(`${engine}: ${(err as Error).message.slice(0, 160)}`);
      continue;
    }
    if (!parsed) {
      problems.push(`${engine} returned nothing to read.`);
      continue;
    }

    for (const item of parsed.items) {
      const target = item.url ? unwrapRedirect(item.url) : null;
      const readable = Boolean(target && !target.includes(ENGINES[engine].opaque));
      const canonical = target ? canonicalUrl(target) : null;
      const key = canonical ?? `${engine}:${item.guid}`;

      // The same story from both engines is one result, and the readable
      // address wins — that is the whole reason for asking both.
      const existing = byKey.get(key);
      if (existing && (existing.readable || !readable)) continue;

      const have = alreadyHave(canonical, target);
      byKey.set(key, {
        title: titleOf(item),
        url: target,
        summary: item.summary
          ? item.summary.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500)
          : null,
        publishedAt: item.publishedAt,
        outlet: outletOf(item),
        engine,
        readable,
        sourceId: have.sourceId ?? null,
      });
    }
  }

  const results = [...byKey.values()]
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, limit);

  return { results, problems };
}

/**
 * Pulls chosen results into the library and starts reading them.
 *
 * Deliberately not held for review: choosing one here IS the review. It is
 * marked kept for the same reason, so it lands in the week beside everything
 * you kept from the inbox rather than sitting outside the record.
 */
export async function pull(
  items: { url: string; title?: string; publishedAt?: string; outlet?: string; summary?: string }[]
): Promise<{ added: number; skipped: number; failed: { url: string; error: string }[] }> {
  let added = 0;
  let skipped = 0;
  const failed: { url: string; error: string }[] = [];

  for (const item of items) {
    const target = unwrapRedirect(item.url);
    if (alreadyHave(canonicalUrl(target), target).sourceId) {
      skipped++;
      continue;
    }
    try {
      const result = await addUrl({
        url: target,
        title: item.title,
        publishedAt: item.publishedAt,
        outlet: item.outlet,
        fallbackText: [item.title, item.summary].filter(Boolean).join("\n\n"),
      });
      db()
        .prepare("UPDATE sources SET triage='kept', kept_at=datetime('now') WHERE id=?")
        .run(result.sourceId);
      added++;
    } catch (err) {
      failed.push({ url: target, error: (err as Error).message.slice(0, 200) });
    }
  }

  return { added, skipped, failed };
}
