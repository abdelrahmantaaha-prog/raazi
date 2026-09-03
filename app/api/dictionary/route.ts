import { NextResponse } from "next/server";
import { define } from "@/lib/dictionary";

export const dynamic = "force-dynamic";

/**
 * Proxied rather than called from the reader directly, for the ordinary reason:
 * Wikimedia does not send CORS headers a browser will accept for this endpoint,
 * and going through the server is also what makes the cache shared across
 * every source you read.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  // A word, not a sentence: the cache is keyed on it and the upstream path
  // segment is built from it, so the length and shape are bounded here.
  const word = (params.get("word") ?? "").trim().slice(0, 80);
  const raw = params.get("lang")?.trim().toLowerCase();
  const lang = raw && /^[a-z]{2,3}$/.test(raw) ? raw : undefined;

  if (!word) return NextResponse.json({ definition: null });

  const definition = await define(word, lang);
  return NextResponse.json({ definition });
}
