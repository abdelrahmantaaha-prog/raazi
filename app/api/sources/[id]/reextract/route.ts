import { NextResponse } from "next/server";
import { accepted, asId, badRequest, notFound } from "@/lib/http";
import { db } from "@/lib/db";
import { reextractSource } from "@/lib/reextract";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/**
 * Reads a source again — the part you have read, or all of it if you have
 * read none. The logic lives in lib/reextract.ts, where the tests can reach
 * it without starting a worker.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sourceId = asId((await ctx.params).id);
  if (sourceId === null) return badRequest("Not a valid id.");

  // The most expensive button in the app: it withdraws every quote from the
  // read part of a book and reads it again. A second click while the first is
  // still going would pay for the whole book twice.
  const running = db()
    .prepare(
      `SELECT r.id FROM runs r
        WHERE r.source_id = ? AND r.kind IN ('reextract','enhance')
          AND r.state IN ('queued','running','paused_quota','paused_key','paused_budget')
          AND EXISTS (SELECT 1 FROM tasks t WHERE t.run_id = r.id AND t.state IN ('pending','running'))
        ORDER BY r.id DESC LIMIT 1`
    )
    .get(sourceId) as { id: number } | undefined;
  if (running) return accepted(running.id, "This source is already being read again.");

  const result = reextractSource(sourceId);
  if ("error" in result) {
    return result.error.startsWith("No such")
      ? notFound(result.error)
      : NextResponse.json({ error: result.error }, { status: 400 });
  }

  kickWorker();

  const { scope, chunks, totalChunks, removed, orphaned, runId } = result;
  const scopeNote =
    scope === "read"
      ? `Re-reading the ${chunks} passage${chunks === 1 ? "" : "s"} you have read` +
        (chunks < totalChunks
          ? ` — the other ${totalChunks - chunks} stay as they are until you reach them. `
          : ". ")
      : `Re-reading all ${chunks} passage${chunks === 1 ? "" : "s"}. `;

  return NextResponse.json({
    runId,
    scope,
    chunks,
    note:
      scopeNote +
      `Withdrew ${removed} quote${removed === 1 ? "" : "s"}` +
      (orphaned > 0
        ? `, and removed ${orphaned} entit${orphaned === 1 ? "y" : "ies"} left with no evidence.`
        : ".") +
      " Watch the Library for progress.",
  });
}
