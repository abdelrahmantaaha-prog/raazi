import { NextResponse } from "next/server";
import { asId, badRequest, exists, notFound, optionalId, optionalString, readBody } from "@/lib/http";
import { db, tx } from "@/lib/db";
import { deleteTag, listTags, renameTag } from "@/lib/tags";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const body = await readBody<{
    action: "rename" | "merge";
    name?: string;
    description?: string | null;
    /** For merge: the tag folded into this one. */
    otherId?: number;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  if (!exists("tags", id)) return notFound("No such tag.");

  if (body.action === "rename") {
    const name = optionalString(body.name);
    if (name === null) return badRequest("name must be a string.");
    const description = body.description === null ? null : optionalString(body.description);
    if (description === null && body.description !== null) {
      return badRequest("description must be a string.");
    }
    // Only what was sent changes: a rename without a description leaves the
    // description as it was, instead of wiping it.
    renameTag(id, { name, description });
    return NextResponse.json({ tags: listTags() });
  }

  if (body.action === "merge") {
    const otherId = optionalId(body.otherId);
    if (!otherId) return badRequest("otherId must be a tag id.");
    if (otherId === id) return badRequest("A tag cannot be merged into itself.");
    if (!exists("tags", otherId)) return notFound("No such tag to merge.");
    // Two names for one topic — a thing the AI tagger will occasionally produce.
    tx(() => {
      db().prepare("UPDATE OR IGNORE source_tags SET tag_id=? WHERE tag_id=?").run(id, otherId);
      db().prepare("UPDATE OR IGNORE entity_tags SET tag_id=? WHERE tag_id=?").run(id, otherId);
      deleteTag(otherId);
    });
    return NextResponse.json({ tags: listTags() });
  }

  return badRequest("Unknown action.");
}

/** Removes the label only. Sources, entities and evidence are untouched. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (!exists("tags", id)) return notFound("No such tag.");
  deleteTag(id);
  return NextResponse.json({ tags: listTags() });
}
