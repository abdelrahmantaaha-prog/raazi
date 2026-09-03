import { NextResponse } from "next/server";
import { asId, badRequest, exists, notFound, readBody } from "@/lib/http";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Starring a quote puts it in the quote bank on /quotes. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const parsed = await readBody<{ starred: boolean }>(req);
  if (parsed === null) return badRequest("Malformed JSON body.");
  if (typeof parsed.starred !== "boolean") return badRequest("starred must be true or false.");
  // A star on a passage that is not there any more used to answer {ok:true},
  // and the page kept showing a star nothing had recorded.
  if (!exists("mentions", id)) return notFound("That passage is no longer here.");
  db().prepare("UPDATE mentions SET starred=? WHERE id=?").run(parsed.starred ? 1 : 0, id);
  return NextResponse.json({ ok: true, starred: parsed.starred });
}
