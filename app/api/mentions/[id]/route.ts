import { NextResponse } from "next/server";
import { asId, badRequest, readBody } from "@/lib/http";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Starring a quote puts it in the quote bank on /quotes. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const parsed = await readBody<{ starred: boolean }>(req);
  if (parsed === null) return badRequest("Malformed JSON body.");
  const { starred } = parsed;
  db().prepare("UPDATE mentions SET starred=? WHERE id=?").run(starred ? 1 : 0, id);
  return NextResponse.json({ ok: true });
}
