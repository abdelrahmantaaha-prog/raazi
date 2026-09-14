import { NextResponse } from "next/server";
import { searchCitable } from "@/lib/cite-search";

export const dynamic = "force-dynamic";

/**
 * The desk's library search, for citing: sources by name, passages by their
 * text. Word matching over SQLite and nothing else — see lib/cite-search.ts.
 */
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 200);
  return NextResponse.json(searchCitable(q));
}
