import { NextResponse } from "next/server";
import { queueStaleEntries, staleCount } from "@/lib/entries";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** How much is out of date, for the Library to offer without you asking. */
export async function GET() {
  return NextResponse.json(staleCount());
}

/** Bring every out-of-date entry back in line with its evidence. */
export async function POST() {
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
