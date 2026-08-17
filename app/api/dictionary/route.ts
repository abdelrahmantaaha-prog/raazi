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
  const word = params.get("word") ?? "";
  const lang = params.get("lang") ?? undefined;

  if (!word.trim()) return NextResponse.json({ definition: null });

  const definition = await define(word, lang ?? undefined);
  return NextResponse.json({ definition });
}
