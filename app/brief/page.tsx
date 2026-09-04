import { citationsFor, getBrief, latestBrief, listBriefs, todayKey } from "@/lib/brief";
import { listWatchlist } from "@/lib/watchlist";
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
      citations={brief ? citationsFor(brief.body_md) : []}
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
