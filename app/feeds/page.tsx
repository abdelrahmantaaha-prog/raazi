import { listFeeds } from "@/lib/feeds";
import { listTags } from "@/lib/tags";
import { db } from "@/lib/db";
import { FeedsManager } from "./FeedsManager";

export const dynamic = "force-dynamic";

export default async function FeedsPage() {
  const feeds = listFeeds();
  const tags = listTags();

  const feedTags = db()
    .prepare("SELECT feed_id, tag_id FROM feed_tags")
    .all() as { feed_id: number; tag_id: number }[];

  const recent = db()
    .prepare(
      `SELECT i.id, i.title, i.state, i.note, i.published_at, i.source_id, f.title AS feed
         FROM feed_items i JOIN feeds f ON f.id = i.feed_id
        ORDER BY COALESCE(i.published_at, i.seen_at) DESC
        LIMIT 40`
    )
    .all() as {
    id: number;
    title: string;
    state: string;
    note: string | null;
    published_at: string | null;
    source_id: number | null;
    feed: string;
  }[];

  return (
    <FeedsManager
      feeds={feeds.map((f) => ({
        id: f.id,
        url: f.url,
        title: f.title,
        outlet: f.outlet,
        kind: f.kind,
        reliability: f.reliability,
        enabled: Boolean(f.enabled),
        intervalMinutes: f.interval_minutes,
        dailyCap: f.daily_cap,
        lastPolledAt: f.last_polled_at,
        lastStatus: f.last_status,
        items: f.items,
        ready: f.ready,
        pending: f.pending,
        tagIds: feedTags.filter((t) => t.feed_id === f.id).map((t) => t.tag_id),
      }))}
      tags={tags.map((t) => ({ id: t.id, name: t.name }))}
      recent={recent}
    />
  );
}
