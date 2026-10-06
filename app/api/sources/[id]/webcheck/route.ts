import { asId, badRequest, notFound } from "@/lib/http";
import { db } from "@/lib/db";
import { startTextWebcheck } from "@/lib/text-webcheck";

export const dynamic = "force-dynamic";

/** Checks what a source claims on the open web. Reports beside it; never edits it. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const source = db().prepare("SELECT title FROM sources WHERE id=?").get(id) as { title: string } | undefined;
  if (!source) return notFound("No such source.");
  return startTextWebcheck("source", id, source.title);
}
