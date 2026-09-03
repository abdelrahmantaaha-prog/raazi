import { db } from "@/lib/db";
import { citationOf } from "@/lib/queries";
import { formatLocator } from "@/lib/chunk";
import type { Locator } from "@/lib/types";
import { getBrief, latestBrief, listBriefs, todayKey } from "@/lib/brief";
import { listWatchlist } from "@/lib/watchlist";
import { citedIds } from "@/lib/markers";
import { BriefView } from "./BriefView";

export const dynamic = "force-dynamic";

/**
 * The page you open first.
 *
 * The brief is stored as Markdown with the same [[m:ID]] citation markers an
 * entry uses, so it is rendered by the same component and every line in it
 * opens the passage it came from. That is the whole point of building it from
 * the database rather than from the morning's articles: it is a view of the
 * library, and it can be checked.
 */
export default async function BriefPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  const params = await searchParams;
  const day = params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : undefined;
  const brief = day ? getBrief(day) : latestBrief();
  const briefs = listBriefs(30);

  // Only the passages this brief actually cites, resolved for the popover.
  const ids = brief ? [...citedIds(brief.body_md)] : [];
  const citations = ids.length
    ? (db()
        .prepare(
          `SELECT m.id, m.quote, m.chunk_id, m.source_id, m.entity_id,
                  e.canonical_name AS entity_name,
                  s.title AS source_title, s.author AS source_author, s.year AS source_year,
                  s.outlet, s.published_at, s.url,
                  c.locator_json, d.label AS doc_label
             FROM mentions m
             JOIN entities e ON e.id = m.entity_id
             JOIN sources  s ON s.id = m.source_id
             JOIN chunks   c ON c.id = m.chunk_id
        LEFT JOIN documents d ON d.id = c.doc_id
            WHERE m.id IN (${ids.map(() => "?").join(",")})`
        )
        .all(...ids) as {
        id: number;
        quote: string;
        chunk_id: number;
        source_id: number;
        entity_id: number;
        entity_name: string;
        source_title: string;
        source_author: string | null;
        source_year: string | null;
        outlet: string | null;
        published_at: string | null;
        url: string | null;
        locator_json: string;
        doc_label: string | null;
      }[])
    : [];

  const rendered = citations.map((c) => ({
    id: c.id,
    quote: c.quote,
    citation: citationOf({
      source_author: c.source_author,
      source_title: c.source_title,
      source_year: c.source_year,
      locator: formatLocator(JSON.parse(c.locator_json) as Locator, c.doc_label),
    }),
    sourceId: c.source_id,
    sourceTitle: c.source_title,
    locator: formatLocator(JSON.parse(c.locator_json) as Locator, c.doc_label),
    chunkId: c.chunk_id,
    entityId: c.entity_id,
    entityName: c.entity_name,
    outlet: c.outlet,
    publishedAt: c.published_at,
    url: c.url,
  }));

  const watchlist = listWatchlist();
  const stats = brief ? (JSON.parse(brief.stats_json || "{}") as Record<string, number>) : {};

  return (
    <BriefView
      today={todayKey()}
      brief={
        brief
          ? {
              day: brief.day,
              body: brief.body_md,
              state: brief.state,
              from: brief.window_from,
              to: brief.window_to,
              error: brief.error,
            }
          : null
      }
      days={briefs.map((b) => ({ day: b.day, state: b.state }))}
      citations={rendered}
      watchlist={watchlist.map((w) => ({
        id: w.id,
        label: w.label,
        kind: w.kind,
        entityId: w.entity_id,
        recent: w.recent,
      }))}
      stats={stats}
    />
  );
}
