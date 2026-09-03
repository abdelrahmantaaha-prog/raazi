import { NextResponse } from "next/server";
import { accepted, badRequest, inFlight, readBody } from "@/lib/http";
import { getBrief, latestBrief, listBriefs, todayKey } from "@/lib/brief";
import { queueBrief } from "@/lib/pipeline/brief";
import { getConfig } from "@/lib/config";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const day = new URL(req.url).searchParams.get("day");
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return badRequest("A day looks like 2026-09-03.");
  const brief = day ? getBrief(day) : latestBrief();
  return NextResponse.json({ brief: brief ?? null, briefs: listBriefs() });
}

export async function POST(req: Request) {
  const body = await readBody<{ day?: string; hours?: number; force?: boolean }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  const day = body.day ?? todayKey();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return badRequest("A day looks like 2026-09-03.");
  if (body.hours !== undefined && (!Number.isFinite(body.hours) || body.hours < 1 || body.hours > 24 * 14)) {
    return badRequest("A window between one hour and a fortnight.");
  }

  const running = inFlight("brief", { day });
  if (running) return accepted(running, "That brief is already being written.");

  const queued = queueBrief({
    day,
    hours: body.hours ?? getConfig().briefHours,
    force: Boolean(body.force),
  });
  if (!queued) {
    return NextResponse.json({ note: "That brief is already written. Ask again with force to rewrite it." });
  }
  kickWorker();
  return NextResponse.json(queued);
}
