import { NextResponse } from "next/server";
import { listRuns, wakeDueRuns } from "@/lib/queue";
import { kickWorker, workerStatus } from "@/lib/worker";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const runs = listRuns();
  // Any queued work means the worker should be alive; a page load is as good a
  // trigger as any after a server restart. Parked runs count too — one whose
  // timer has passed needs someone to notice, and the worker is what checks.
  const due = wakeDueRuns();
  if (due > 0 || runs.some((r) => ["queued", "running", "paused_quota"].includes(r.state))) {
    kickWorker();
  }

  const sources = db()
    .prepare(
      `SELECT s.id, s.title, s.kind, s.author, s.status, s.note, s.added_at,
              s.publisher, s.year, s.url, s.bookmark_chunk, s.shelf,
              s.progress, s.read_mode, s.read_at, s.reading_state,
              (SELECT COALESCE(SUM(LENGTH(c.text)), 0) / 6 FROM chunks c WHERE c.source_id=s.id) AS words,
              (SELECT COUNT(*) FROM chunks c WHERE c.source_id=s.id) AS chunks,
              (SELECT COUNT(*) FROM chunks c WHERE c.source_id=s.id AND c.extracted_at IS NOT NULL) AS read_chunks,
              (SELECT COUNT(*) FROM bookmarks b WHERE b.source_id=s.id) AS bookmarks,
              (SELECT COUNT(DISTINCT m.entity_id) FROM mentions m WHERE m.source_id=s.id) AS entities
         FROM sources s ORDER BY s.id DESC`
    )
    .all();

  const totals = db()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM entities WHERE merged_into IS NULL) AS entities,
              (SELECT COUNT(*) FROM mentions) AS mentions,
              (SELECT COUNT(*) FROM entries)  AS entries,
              (SELECT COUNT(*) FROM entities WHERE entry_state='stale' AND merged_into IS NULL) AS stale`
    )
    .get();

  return NextResponse.json({ runs, sources, totals, worker: workerStatus() });
}
