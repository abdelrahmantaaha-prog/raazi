import { NextResponse } from "next/server";
import { accepted, badRequest, inFlight, readBody } from "@/lib/http";
import { ExpandError, findExpansion, listExpansions, requestExpansion } from "@/lib/expansions";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The expansions written for one brief. */
export async function GET(req: Request) {
  const day = new URL(req.url).searchParams.get("day");
  if (!day || !DAY.test(day)) return badRequest("A day looks like 2026-09-03.");
  return NextResponse.json({ expansions: listExpansions(day) });
}

/** Expand one heading: `{ day, heading, force? }`. */
export async function POST(req: Request) {
  const body = await readBody<{ day?: string; heading?: string; force?: boolean }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  if (typeof body.day !== "string" || !DAY.test(body.day)) return badRequest("A day looks like 2026-09-03.");
  if (typeof body.heading !== "string" || !body.heading.trim() || body.heading.length > 300) {
    return badRequest("Say which heading to expand.");
  }

  const existing = findExpansion(body.day, body.heading);
  if (existing) {
    const running = inFlight("expand", { expansionId: existing.id });
    if (running) return accepted(running, "That heading is already being expanded.", { expansion: existing });
  }

  try {
    const result = requestExpansion(body.day, body.heading, { force: Boolean(body.force) });
    if (result.runId) kickWorker();
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ExpandError) return badRequest(err.message);
    throw err;
  }
}
