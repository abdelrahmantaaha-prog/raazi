import { NextResponse } from "next/server";
import { asId, badRequest } from "@/lib/http";
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

  const result = reextractSource(sourceId);
  if ("error" in result) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error.startsWith("No such") ? 404 : 400 }
    );
  }

  kickWorker();

  const { scope, chunks, totalChunks, removed, orphaned, runId } = result;
  const scopeNote =
    scope === "read"
      ? `Re-reading the ${chunks} passage${chunks === 1 ? "" : "s"} you've read` +
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
