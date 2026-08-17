import { NextResponse } from "next/server";
import { asId, badRequest, readBody } from "@/lib/http";
import { ensureTag, setSourceTags, tagsForSource } from "@/lib/tags";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
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

  const ids = [...(body.tagIds ?? [])];
  if (body.newTag?.trim()) ids.push(ensureTag(body.newTag));

  setSourceTags(sourceId, ids, "user");
  return NextResponse.json({ tags: tagsForSource(sourceId) });
}
