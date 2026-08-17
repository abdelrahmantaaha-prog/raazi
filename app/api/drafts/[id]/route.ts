import { NextResponse } from "next/server";
import { asId, badRequest, readBody } from "@/lib/http";
import { citationsFor, deleteDraft, getDraft, notesFor, saveDraft } from "@/lib/drafts";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const draft = getDraft(id);
  if (!draft) return NextResponse.json({ error: "No such draft." }, { status: 404 });
  return NextResponse.json({ draft, notes: notesFor(id), citations: citationsFor(id) });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const parsed = await readBody<{
    title?: string;
    body_html?: string;
    body_md?: string;
  }>(req);
  if (parsed === null) return badRequest("Malformed JSON body.");
  const { title, body_html, body_md } = parsed;
  saveDraft(id, { title, body_html, body_md });
  return NextResponse.json({ draft: getDraft(id) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  deleteDraft(id);
  return NextResponse.json({ ok: true });
}
