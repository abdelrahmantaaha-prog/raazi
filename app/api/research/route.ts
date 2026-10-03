import { NextResponse } from "next/server";
import { asId, badRequest, notFound, readBody } from "@/lib/http";
import { findCounts, getFind, listFinds, setFindState } from "@/lib/research/finds";
import { addUrl } from "@/lib/ingest";

export const dynamic = "force-dynamic";

/** The Research inbox: what web checks turned up, waiting for you to rule on it. */
export async function GET(req: Request) {
  const state = new URL(req.url).searchParams.get("state");
  const which = state === "kept" || state === "dismissed" ? state : "new";
  return NextResponse.json({ finds: listFinds(which), counts: findCounts() });
}

/**
 * Keep, dismiss or bring back one lead.
 *
 * Keeping a page adds it to the library as a source, through the same reading
 * every other source gets, so whatever it adds reaches an entry with a quote
 * behind it. A shipment's tracking page cannot be read that way — it needs a
 * browser — so keeping one only marks it dealt with.
 */
export async function POST(req: Request) {
  const body = await readBody<{ id?: number; action?: "keep" | "dismiss" | "restore" }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  const id = asId(body.id ?? null);
  if (id === null) return badRequest("id required.");
  const find = getFind(id);
  if (!find) return notFound("No such lead.");

  switch (body.action) {
    case "keep": {
      if (find.state === "kept") return NextResponse.json({ find });
      if (find.kind === "shipment") {
        setFindState(id, "kept");
        return NextResponse.json({ find: getFind(id), note: "Marked as dealt with." });
      }
      try {
        const added = await addUrl({ url: find.url, title: find.title ?? undefined });
        setFindState(id, "kept", added.sourceId);
        return NextResponse.json({ find: getFind(id), sourceId: added.sourceId, runId: added.runId, note: added.note });
      } catch (err) {
        return NextResponse.json({ error: (err as Error).message || "Could not add that page." }, { status: 500 });
      }
    }
    case "dismiss":
      setFindState(id, "dismissed");
      return NextResponse.json({ find: getFind(id) });
    case "restore":
      setFindState(id, "new");
      return NextResponse.json({ find: getFind(id) });
    default:
      return badRequest("Unknown action.");
  }
}
