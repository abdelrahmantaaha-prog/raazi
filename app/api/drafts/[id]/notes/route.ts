import { NextResponse } from "next/server";
import { asId, badRequest, readBody } from "@/lib/http";
import { addNote, removeNote, reorderNotes } from "@/lib/drafts";

export const dynamic = "force-dynamic";

/**
 * Gathering material. Pure bookkeeping — the text is copied in from whatever
 * you were looking at, and nothing decides for you what is worth keeping.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const body = await readBody<{
    text: string;
    kind?: "quote" | "passage" | "entry";
    citation?: string;
    entityId?: number;
    mentionId?: number;
    chunkId?: number;
    sourceId?: number;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  if (!body.text?.trim()) {
    return NextResponse.json({ error: "Nothing to keep." }, { status: 400 });
  }

  const notes = addNote(id, {
    text: body.text.trim(),
    kind: body.kind ?? "quote",
    citation: body.citation ?? null,
    entity_id: body.entityId ?? null,
    mention_id: body.mentionId ?? null,
    chunk_id: body.chunkId ?? null,
    source_id: body.sourceId ?? null,
  });

  return NextResponse.json({ notes });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const parsed = await readBody<{ order: number[] }>(req);
  if (parsed === null) return badRequest("Malformed JSON body.");
  const { order } = parsed;
  return NextResponse.json({ notes: reorderNotes(id, order ?? []) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const noteId = Number(new URL(req.url).searchParams.get("note"));
  return NextResponse.json({ notes: removeNote(id, noteId) });
}
