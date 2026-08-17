import { NextResponse } from "next/server";
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
  const { force } = (await req.json().catch(() => ({}))) as { force?: boolean };

  const runId = createRun({ kind: "portraits", label: "Finding pictures" });
  enqueue(runId, [{ kind: "plan_portraits", payload: { force: force === true } }]);
  kickWorker();

  return NextResponse.json({ runId, note: "Looking for pictures — watch the progress above." });
}
