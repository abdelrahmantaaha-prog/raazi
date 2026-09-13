import { NextResponse } from "next/server";
import {
  asId,
  badRequest,
  notFound,
  optionalId,
  optionalString,
  queryId,
  readBody,
} from "@/lib/http";
import { addNote, citationForSource, getDraft, removeNote, reorderNotes } from "@/lib/drafts";

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

  const text = optionalString(body.text);
  const citation = optionalString(body.citation);
  if (text === null || citation === null) return badRequest("text and citation must be strings.");
  if (!text?.trim()) {
    return NextResponse.json({ error: "Nothing to keep." }, { status: 400 });
  }
  const kind = body.kind ?? "quote";
  if (!["quote", "passage", "entry"].includes(kind)) return badRequest("Unknown note kind.");

  // The links are optional and SET NULL on delete, but an id that was never a
  // row is a constraint error, which used to answer as a 500.
  const refs = {
    entityId: optionalId(body.entityId),
    mentionId: optionalId(body.mentionId),
    chunkId: optionalId(body.chunkId),
    sourceId: optionalId(body.sourceId),
  };
  for (const [k, v] of Object.entries(refs)) if (v === null) return badRequest(`${k} is not an id.`);

  if (!getDraft(id)) return notFound("No such draft.");

  // A passage sent from the reader names its source and its place but not a
  // citation; one is rendered here, the same way the desk's search renders
  // its hits, so the two read alike at the foot of the page.
  const cited =
    citation?.trim() || (refs.sourceId ? citationForSource(refs.sourceId, refs.chunkId ?? null) : null);

  try {
    const notes = addNote(id, {
      text: text.trim(),
      kind,
      citation: cited ?? null,
      entity_id: refs.entityId ?? null,
      mention_id: refs.mentionId ?? null,
      chunk_id: refs.chunkId ?? null,
      source_id: refs.sourceId ?? null,
    });
    return NextResponse.json({ notes });
  } catch (err) {
    if (/FOREIGN KEY/i.test((err as Error).message)) {
      return notFound("One of the things this note points at no longer exists.");
    }
    throw err;
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const parsed = await readBody<{ order: number[] }>(req);
  if (parsed === null) return badRequest("Malformed JSON body.");
  const order = Array.isArray(parsed.order) ? parsed.order.map((n) => asId(n)) : [];
  if (order.some((n) => n === null)) return badRequest("order must be a list of note ids.");
  if (!getDraft(id)) return notFound("No such draft.");
  return NextResponse.json({ notes: reorderNotes(id, order as number[]) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const noteId = queryId(req, "note");
  if (noteId === null) return badRequest("note must be a note id.");
  if (!getDraft(id)) return notFound("No such draft.");
  return NextResponse.json({ notes: removeNote(id, noteId) });
}
