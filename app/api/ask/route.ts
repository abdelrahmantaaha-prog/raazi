import { NextResponse } from "next/server";
import { badRequest, optionalId, readBody } from "@/lib/http";
import { askLibrary, coverage, embedPassages } from "@/lib/meaning-search";
import { askWithReader, canEmbed } from "@/lib/ask-reader";

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
  return NextResponse.json({ coverage: coverage(sourceId ?? undefined), canEmbed: canEmbed() });
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
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  // Meaning search needs Gemini to turn the question into a vector. Without a
  // usable key — or when it fails — Claude searches instead (lib/ask-reader.ts).
  if (canEmbed()) {
    try {
      return NextResponse.json({ ...(await askLibrary(question, { limit, sourceId })), by: "meaning" });
    } catch {
      /* fall through to the reader */
    }
  }
  try {
    const results = await askWithReader(question, { limit, sourceId });
    return NextResponse.json({ results, coverage: coverage(sourceId), by: "reader" });
  } catch (err) {
    return badRequest((err as Error).message);
  }
}
