import { NextResponse } from "next/server";
import { asId, badRequest, notFound } from "@/lib/http";
import { undoMerge } from "@/lib/pipeline/resolve";

export const dynamic = "force-dynamic";

/** Splits a merged entity back out. The resolver records the split so it does
 *  not helpfully re-merge them on the next pass. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const ok = undoMerge(id);
  if (!ok) return notFound("Merge not found or already undone.");
  return NextResponse.json({ ok: true });
}
