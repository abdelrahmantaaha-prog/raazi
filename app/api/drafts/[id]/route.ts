import { NextResponse } from "next/server";
import { textWebCheck } from "@/lib/web-checks";
import { asId, badRequest, notFound, optionalString, readBody } from "@/lib/http";
import { citationsFor, deleteDraft, getDraft, notesFor, repairCitations, saveDraft } from "@/lib/drafts";

export const dynamic = "force-dynamic";

/**
 * A draft, its shelf and its references. `?repair=1` — sent when the desk
 * opens a draft, not when it re-reads the shelf — first brings its citations
 * up to the current rules (`repairCitations`), so a page already showing the
 * draft is never handed references it has not seen.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (new URL(req.url).searchParams.get("repair") === "1" && getDraft(id)) repairCitations(id);
  const draft = getDraft(id);
  if (!draft) return notFound("No such draft.");
  return NextResponse.json({ draft, notes: notesFor(id), citations: citationsFor(id), webCheck: textWebCheck("draft", id) ?? null });
}

/**
 * Saves what the editor sends. The HTML is reduced to the allowed markup in
 * `saveDraft` (see the sanitiser in lib/drafts.ts) — a body stored verbatim
 * was a script anyone on the network could leave for your browser to run.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const parsed = await readBody<{
    title?: string;
    body_html?: string;
    body_md?: string;
  }>(req);
  if (parsed === null) return badRequest("Malformed JSON body.");
  const title = optionalString(parsed.title);
  const body_html = optionalString(parsed.body_html);
  const body_md = optionalString(parsed.body_md);
  if (title === null || body_html === null || body_md === null) {
    return badRequest("title, body_html and body_md must be strings.");
  }
  if (!getDraft(id)) return notFound("No such draft.");
  saveDraft(id, { title, body_html, body_md });
  return NextResponse.json({ draft: getDraft(id) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (!getDraft(id)) return notFound("No such draft.");
  deleteDraft(id);
  return NextResponse.json({ ok: true });
}
