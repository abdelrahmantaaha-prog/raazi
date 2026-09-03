import { NextResponse } from "next/server";
import { accepted, badRequest, inFlight, readBody } from "@/lib/http";
import { db } from "@/lib/db";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";
import { cachedPortrait, knownMiss } from "@/lib/portraits";

export const dynamic = "force-dynamic";

/** How many entries have a picture, have been checked, or are still unasked. */
export async function GET() {
  const entries = db()
    .prepare(
      `SELECT e.id FROM entities e
        WHERE e.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM entries en WHERE en.entity_id = e.id)`
    )
    .all() as { id: number }[];

  let withPicture = 0;
  let checked = 0;
  for (const e of entries) {
    if (cachedPortrait(e.id)) withPicture++;
    else if (knownMiss(e.id)) checked++;
  }

  return NextResponse.json({
    entries: entries.length,
    withPicture,
    checked,
    pending: entries.length - withPicture - checked,
  });
}

/**
 * Looks for pictures for every entry that has not been checked.
 *
 * Queued rather than done here: Wikidata allows about one request every second
 * and a few hundred entries is minutes of work, which belongs in the durable
 * queue where it can be paused, closed and resumed like anything else.
 */
export async function POST(req: Request) {
  const body = (await readBody<{ force?: boolean }>(req)) ?? {};
  if (body.force !== undefined && typeof body.force !== "boolean") {
    return badRequest("force must be true or false.");
  }

  // One hunt at a time. It is minutes of rate-limited work and a second one
  // would ask Wikidata the same questions in parallel with the first.
  const running = inFlight("plan_portraits") ?? inFlight("portrait");
  if (running) return accepted(running, "Pictures are already being looked for.");

  const runId = createRun({ kind: "portraits", label: "Finding pictures" });
  enqueue(runId, [{ kind: "plan_portraits", payload: { force: body.force === true } }]);
  kickWorker();

  return NextResponse.json({ runId, note: "Looking for pictures — watch the progress above." });
}
