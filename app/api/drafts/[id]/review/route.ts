import { NextResponse } from "next/server";
import { asId, badRequest, notFound, readBody } from "@/lib/http";
import { getDraft, saveReviewed } from "@/lib/drafts";

export const dynamic = "force-dynamic";

/**
 * Which paragraphs you have reviewed. The whole list each time, as the desk
 * holds it: the fingerprints of the paragraphs still in the draft that you
 * have marked (see app/write/review.ts).
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const body = await readBody<{ reviewed?: unknown }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  if (!Array.isArray(body.reviewed)) return badRequest("reviewed must be a list.");
  if (!getDraft(id)) return notFound("No such draft.");
  return NextResponse.json({ reviewed: saveReviewed(id, body.reviewed) });
}
