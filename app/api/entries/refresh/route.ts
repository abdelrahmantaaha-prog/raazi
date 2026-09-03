import { NextResponse } from "next/server";
import { accepted, inFlight } from "@/lib/http";
import { db } from "@/lib/db";
import { queueStaleEntries, refreshInFlight, staleCount } from "@/lib/entries";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** How much is out of date, for the Library to offer without you asking. */
export async function GET() {
  return NextResponse.json({ ...staleCount(), running: refreshInFlight() });
}

/**
 * Bring every out-of-date entry back in line with its evidence.
 *
 * Guarded by the same check the worker's own sweep uses: a refresh already
 * queued covers everything this one would queue, and pressing the button twice
 * used to mean writing every stale entry twice.
 */
export async function POST() {
  if (refreshInFlight()) {
    const open = db()
      .prepare(
        `SELECT t.run_id FROM tasks t JOIN runs r ON r.id = t.run_id
          WHERE t.kind IN ('entry','plan_entries') AND t.state IN ('pending','running')
          ORDER BY t.run_id DESC LIMIT 1`
      )
      .get() as { run_id: number } | undefined;
    return accepted(
      open?.run_id ?? inFlight("entry") ?? 0,
      "Entries are already being brought up to date — watch the progress above."
    );
  }

  const queued = queueStaleEntries("Updating entries");
  if (!queued) {
    return NextResponse.json({ queued: 0, note: "Every entry is already up to date." });
  }
  kickWorker();
  return NextResponse.json({
    ...queued,
    note: `Updating ${queued.queued} entr${queued.queued === 1 ? "y" : "ies"} — watch the progress above.`,
  });
}
