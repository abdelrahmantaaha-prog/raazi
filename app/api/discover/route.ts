import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { pull, search, type Engine } from "@/lib/discover";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = await readBody<{
    action?: "search" | "pull";
    query?: string;
    engines?: string[];
    items?: { url?: string; title?: string; publishedAt?: string; outlet?: string; summary?: string }[];
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  if (body.action === "pull") {
    const items = (body.items ?? [])
      .filter((i) => typeof i?.url === "string" && /^https?:\/\//i.test(i.url))
      .slice(0, 50) as { url: string; title?: string; publishedAt?: string; outlet?: string; summary?: string }[];
    if (!items.length) return badRequest("Nothing to pull in.");

    const result = await pull(items);
    if (result.added) kickWorker();
    return NextResponse.json(result);
  }

  const query = (body.query ?? "").trim();
  if (!query) return badRequest("Type something to search for.");
  if (query.length > 200) return badRequest("That is too long for a search.");

  const engines = (body.engines ?? []).filter((e): e is Engine => e === "google" || e === "bing");
  const result = await search(query, engines.length ? { engines } : {});
  return NextResponse.json(result);
}
