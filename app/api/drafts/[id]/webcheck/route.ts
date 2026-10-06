import { asId, badRequest, notFound } from "@/lib/http";
import { db } from "@/lib/db";
import { startTextWebcheck } from "@/lib/text-webcheck";

export const dynamic = "force-dynamic";

/** Checks the draft's claims on the open web. Reports beside the draft; never edits it. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const draft = db().prepare("SELECT title, body_md FROM drafts WHERE id=?").get(id) as
    | { title: string; body_md: string }
    | undefined;
  if (!draft) return notFound("No such draft.");
  if (!draft.body_md.trim()) return badRequest("The draft is empty.");
  return startTextWebcheck("draft", id, draft.title || "Untitled draft");
}
