import { NextResponse } from "next/server";
import { asId, badRequest, exists, notFound, optionalString, readBody } from "@/lib/http";
import { ensureTag, setSourceTags, tagsForSource } from "@/lib/tags";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (!exists("sources", id)) return notFound("No such source.");
  return NextResponse.json({ tags: tagsForSource(id) });
}

/**
 * Re-files a source. Every entity mentioned in it picks up the new tags
 * immediately, because entity tags are derived rather than stored.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sourceId = asId((await ctx.params).id);
  if (sourceId === null) return badRequest("Not a valid id.");
  const body = await readBody<{ tagIds?: number[]; newTag?: string }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  if (body.tagIds !== undefined && !Array.isArray(body.tagIds)) {
    return badRequest("tagIds must be a list of tag ids.");
  }
  const newTag = optionalString(body.newTag);
  if (newTag === null) return badRequest("newTag must be a string.");
  if (!exists("sources", sourceId)) return notFound("No such source.");

  // Every id checked before anything is written. The insert is a foreign key,
  // so one bad id aborted the whole re-filing with a constraint error — and
  // it did so after the delete, leaving the source with no tags at all.
  const ids: number[] = [];
  for (const raw of body.tagIds ?? []) {
    const tagId = asId(raw);
    if (tagId === null) return badRequest("tagIds must be a list of tag ids.");
    if (!exists("tags", tagId)) return notFound(`No such tag (${String(raw)}).`);
    ids.push(tagId);
  }
  if (newTag?.trim()) ids.push(ensureTag(newTag));

  setSourceTags(sourceId, ids, "user");
  return NextResponse.json({ tags: tagsForSource(sourceId) });
}
