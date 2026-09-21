import { NextResponse } from "next/server";
import { badRequest, optionalId, readBody } from "@/lib/http";
import { askLibrary, coverage, embedPassages } from "@/lib/meaning-search";

export const dynamic = "force-dynamic";

/**
 * A vague question, answered with passages rather than an answer.
 *
 * POST with `{ question }` to search; POST with `{ action: "index" }` to give
 * another batch of passages a vector. Indexing is a separate call rather than
 * something the search does for itself, because it is the only part that
 * spends anything and a search that quietly embedded six thousand passages
 * would be a nasty surprise on a metered key.
 *
 * GET reports how much of the library can be searched this way.
 */
export async function GET(req: Request) {
  const sourceId = optionalId(new URL(req.url).searchParams.get("sourceId"));
  return NextResponse.json({ coverage: coverage(sourceId ?? undefined) });
}

export async function POST(req: Request) {
  const body = await readBody<{ question?: unknown; action?: unknown; limit?: unknown; sourceId?: unknown }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  const sourceId = optionalId(body.sourceId) ?? undefined;

  if (body.action === "index") {
    const limit = typeof body.limit === "number" ? body.limit : undefined;
    try {
      const done = await embedPassages({ limit, sourceId });
      return NextResponse.json({ indexed: done, coverage: coverage(sourceId) });
    } catch (err) {
      return badRequest((err as Error).message);
    }
  }

  const question = typeof body.question === "string" ? body.question : "";
  if (!question.trim()) return badRequest("Ask something.");
  try {
    const limit = typeof body.limit === "number" ? body.limit : undefined;
    const found = await askLibrary(question, { limit, sourceId });
    return NextResponse.json(found);
  } catch (err) {
    return badRequest((err as Error).message);
  }
}
