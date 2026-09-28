import { NextResponse } from "next/server";
import { listRuns } from "@/lib/queue";
import { workerStatus } from "@/lib/worker";
import { db } from "@/lib/db";
import { wordsBySource } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * The Library's poll. Reads only: it used to start the worker whenever it saw
 * queued work, so that a page load after a restart would pick things up, but a
 * GET that sets work going is a GET anyone on the network can set going. The
 * launcher now does that once with POST /api/worker/kick, and every action
 * that queues work kicks the worker itself.
 */
export async function GET() {
  const runs = listRuns();

  const sources = db()
    .prepare(
      `SELECT s.id, s.title, s.kind, s.author, s.status, s.note, s.added_at,
              s.publisher, s.year, s.url, s.bookmark_chunk, s.shelf,
              s.progress, s.read_mode, s.read_at, s.reading_state,
              (SELECT COUNT(*) FROM chunks c WHERE c.source_id=s.id) AS chunks,
              (SELECT COUNT(*) FROM chunks c WHERE c.source_id=s.id AND c.extracted_at IS NOT NULL) AS read_chunks,
              (SELECT COUNT(*) FROM bookmarks b WHERE b.source_id=s.id) AS bookmarks,
              (SELECT COUNT(DISTINCT m.entity_id) FROM mentions m WHERE m.source_id=s.id) AS entities
         FROM sources s ORDER BY s.id DESC`
    )
    .all() as { id: number }[];
  // Measured once per source and remembered — see wordsBySource.
  const words = wordsBySource();
  const withWords = sources.map((s) => ({ ...s, words: words.get(s.id) ?? 0 }));

  const totals = db()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM entities WHERE merged_into IS NULL) AS entities,
              (SELECT COUNT(*) FROM mentions) AS mentions,
              (SELECT COUNT(*) FROM entries)  AS entries,
              (SELECT COUNT(*) FROM entities WHERE entry_state='stale' AND merged_into IS NULL) AS stale`
    )
    .get();

  return NextResponse.json({ runs, sources: withWords, totals, worker: workerStatus() });
}
