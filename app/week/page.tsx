import { citationsFor, getBrief, keptBetween, listWeeklyBriefs } from "@/lib/brief";
import { decidedBetween, heldCount } from "@/lib/triage";
import { describeWeek, isCurrentWeek, isWeekKey, nextWeekKey, previousWeekKey, weekKey, weekRange } from "@/lib/week";
import WeekView from "./WeekView";

export const dynamic = "force-dynamic";

/**
 * The week, which is the thing that actually gets presented at work.
 *
 * It fills as you go: every article you keep in the inbox lands here the
 * moment you keep it, so by Thursday the page is already the week's record and
 * the written brief is a summary of something you have watched accumulate
 * rather than a surprise. The window runs Friday to Thursday and rolls on
 * Friday morning — nothing is deleted when it does, the closed week keeps its
 * own page and its own brief.
 */
export default async function WeekPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const params = await searchParams;
  const asked = params.week ? (params.week.startsWith("week:") ? params.week : `week:${params.week}`) : null;
  const key = asked && isWeekKey(asked) ? asked : weekKey();

  const { from, to } = weekRange(key);
  const brief = getBrief(key);
  const kept = keptBetween(from, to);
  const decided = decidedBetween(from, to);

  return (
    <WeekView
      week={key}
      label={describeWeek(key)}
      current={isCurrentWeek(key)}
      from={from.toISOString()}
      to={to.toISOString()}
      previous={previousWeekKey(key)}
      next={isCurrentWeek(key) ? null : nextWeekKey(key)}
      brief={
        brief
          ? {
              body: brief.body_md,
              state: brief.state,
              error: brief.error,
              createdAt: brief.created_at,
              model: brief.model,
            }
          : null
      }
      citations={brief ? citationsFor(brief.body_md) : []}
      kept={kept}
      discarded={decided.discarded}
      held={heldCount()}
      weeks={listWeeklyBriefs().map((b) => ({ week: b.day, state: b.state }))}
    />
  );
}
