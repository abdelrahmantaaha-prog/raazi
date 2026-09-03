import { NextResponse } from "next/server";
import { badRequest, exists, notFound, optionalId, optionalString, queryId, readBody } from "@/lib/http";
import { listWatchlist, unwatch, watch } from "@/lib/watchlist";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ watchlist: listWatchlist() });
}

export async function POST(req: Request) {
  const body = await readBody<{ entityId?: number; tagId?: number; phrase?: string; note?: string }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  const entityId = optionalId(body.entityId);
  const tagId = optionalId(body.tagId);
  const phrase = optionalString(body.phrase);
  if (entityId === null || tagId === null || phrase === null) {
    return badRequest("entityId and tagId must be row ids; phrase must be a string.");
  }
  if (entityId !== undefined && !exists("entities", entityId)) return notFound("No such entity.");
  if (tagId !== undefined && !exists("tags", tagId)) return notFound("No such topic.");
  if (entityId === undefined && tagId === undefined && !phrase?.trim()) {
    return badRequest("Watch an entity, a topic, or a phrase.");
  }

  const id = watch({
    entityId: entityId ?? undefined,
    tagId: tagId ?? undefined,
    phrase: phrase ?? undefined,
    note: optionalString(body.note) ?? undefined,
  });
  return NextResponse.json({ id, watchlist: listWatchlist() });
}

export async function DELETE(req: Request) {
  const id = queryId(req, "id");
  if (!id) return badRequest("Which watch?");
  if (!unwatch(id)) return notFound("That was not on the list.");
  return NextResponse.json({ ok: true, watchlist: listWatchlist() });
}
