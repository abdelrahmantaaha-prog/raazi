import { NextResponse } from "next/server";
import { asId, badRequest, readBody } from "@/lib/http";
import { db, tx } from "@/lib/db";
import { deleteTag, listTags, renameTag } from "@/lib/tags";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const body = await readBody<{
    action: "rename" | "merge";
    name?: string;
    description?: string;
    /** For merge: the tag folded into this one. */
    otherId?: number;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  if (body.action === "rename") {
    renameTag(id, body.name ?? "", body.description);
  }

  if (body.action === "merge" && body.otherId && body.otherId !== id) {
    // Two names for one topic — a thing the AI tagger will occasionally produce.
    tx(() => {
      db()
        .prepare("UPDATE OR IGNORE source_tags SET tag_id=? WHERE tag_id=?")
        .run(id, body.otherId);
      db()
        .prepare("UPDATE OR IGNORE entity_tags SET tag_id=? WHERE tag_id=?")
        .run(id, body.otherId);
      deleteTag(body.otherId!);
    });
  }

  return NextResponse.json({ tags: listTags() });
}

/** Removes the label only. Sources, entities and evidence are untouched. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  deleteTag(id);
  return NextResponse.json({ tags: listTags() });
}
