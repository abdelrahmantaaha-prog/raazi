import { NextResponse } from "next/server";
import { accepted, badRequest, inFlight, readBody } from "@/lib/http";
import { getBrief, keptBetween, listWeeklyBriefs } from "@/lib/brief";
import { queueWeeklyBrief } from "@/lib/pipeline/brief";
import { heldCount } from "@/lib/triage";
import { getConfig } from "@/lib/config";
import { isWeekKey, weekKey, weekRange } from "@/lib/week";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** `?week=2026-09-04`, meaning the week that Friday opened. Defaults to now. */
function keyFrom(param: string | null): string | null {
  if (!param) return weekKey();
  const key = param.startsWith("week:") ? param : `week:${param}`;
  return isWeekKey(key) ? key : null;
}

export async function GET(req: Request) {
  const key = keyFrom(new URL(req.url).searchParams.get("week"));
  if (!key) return badRequest("A week is named by its Friday, like 2026-09-04.");

  const { from, to } = weekRange(key);
  return NextResponse.json({
    week: key,
    from: from.toISOString(),
    to: to.toISOString(),
    brief: getBrief(key) ?? null,
    kept: keptBetween(from, to),
    weeks: listWeeklyBriefs(),
    held: heldCount(),
  });
}

export async function POST(req: Request) {
  const body = await readBody<{ week?: string; force?: boolean }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  const key = keyFrom(body.week ?? null);
  if (!key) return badRequest("A week is named by its Friday, like 2026-09-04.");

  // The whole point of the inbox is that nothing is written over material you
  // have not looked at. Saying so is more useful than quietly writing a brief
  // that is missing half the week.
  const waiting = heldCount();
  if (waiting > 0 && getConfig().feedReview) {
    return NextResponse.json(
      {
        error: `${waiting} article${waiting === 1 ? "" : "s"} still waiting in the inbox. Go through them first — this brief is built from what you keep.`,
        held: waiting,
      },
      { status: 409 }
    );
  }

  const running = inFlight("brief", { day: key });
  if (running) return accepted(running, "That brief is already being written.");

  const queued = queueWeeklyBrief({ week: key, force: Boolean(body.force) });
  if (!queued) {
    return NextResponse.json({
      note: "That week is already written. Ask again with force to rewrite it.",
    });
  }
  kickWorker();
  return NextResponse.json(queued);
}
