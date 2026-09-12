import { NextResponse } from "next/server";
import { asId, badRequest, notFound } from "@/lib/http";
import { heldText } from "@/lib/triage";

export const dynamic = "force-dynamic";

/**
 * The text behind one held item, for the inbox's preview pane.
 *
 * Read-only and free: it is the chunks the fetch already wrote. Its job is
 * to answer, before you spend anything, whether what is here is the article
 * or a paywall's stub — so the verdict is computed server-side with the same
 * rule keep() applies, and the pane only has to print it.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const text = heldText(id);
  if (!text) return notFound("That item is not waiting in the inbox.");
  return NextResponse.json(text);
}
