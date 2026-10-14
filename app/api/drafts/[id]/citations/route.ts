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
import {
  citationsFor,
  citeReference,
  getDraft,
  removeCitation,
  updateCitation,
} from "@/lib/drafts";

export const dynamic = "force-dynamic";

const TEXT_FIELDS = ["text", "author", "title", "year", "locator", "outlet", "url", "quote"] as const;
type TextField = (typeof TEXT_FIELDS)[number];

/** The text fields of a body, checked to be strings (or null, to clear). */
function textFields(body: Record<string, unknown>): Partial<Record<TextField, string | null>> | string {
  const out: Partial<Record<TextField, string | null>> = {};
  for (const k of TEXT_FIELDS) {
    if (body[k] === undefined) continue;
    if (body[k] === null) {
      out[k] = null;
      continue;
    }
    const v = optionalString(body[k]);
    if (v === null) return `${k} must be a string.`;
    out[k] = v;
  }
  return out;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (!getDraft(id)) return notFound("No such draft.");
  return NextResponse.json({ citations: citationsFor(id) });
}

/**
 * Cites a reference — one of yours, or one from outside the library — and
 * says which id the marker should carry: a new reference's, or that of the
 * one already in the list when it is the same reference.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const body = await readBody<Record<string, unknown> & { origin?: string }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  const fields = textFields(body);
  if (typeof fields === "string") return badRequest(fields);
  const origin = body.origin ?? "outside";
  if (origin !== "library" && origin !== "outside") return badRequest("Unknown origin.");
  const sourceId = optionalId(body.sourceId);
  const mentionId = optionalId(body.mentionId);
  const chunkId = optionalId(body.chunkId);
  if (sourceId === null || mentionId === null || chunkId === null) {
    return badRequest("sourceId, mentionId and chunkId must be ids.");
  }

  if (!getDraft(id)) return notFound("No such draft.");

  try {
    const { id: cited, citations } = citeReference(id, {
      origin,
      text: fields.text ?? undefined,
      author: fields.author ?? null,
      title: fields.title ?? null,
      year: fields.year ?? null,
      locator: fields.locator ?? null,
      url: fields.url ?? null,
      quote: fields.quote ?? null,
      source_id: sourceId ?? null,
      mention_id: mentionId ?? null,
      chunk_id: chunkId ?? null,
    });
    if (cited === null) return badRequest("A reference needs a title, an author, an address or some words.");
    return NextResponse.json({ citations, cited });
  } catch (err) {
    if (/FOREIGN KEY/i.test((err as Error).message)) {
      return notFound("The source or passage this cites no longer exists.");
    }
    throw err;
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const body = await readBody<Record<string, unknown>>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  const citationId = optionalId(body.citationId);
  if (!citationId) return badRequest("citationId must be a citation id.");
  const fields = textFields(body);
  if (typeof fields === "string") return badRequest(fields);
  if (!getDraft(id)) return notFound("No such draft.");
  // The rendered text is derived, never cleared: a null there means "render
  // it again from the parts", which is what updateCitation does for undefined.
  const { text, ...rest } = fields;
  return NextResponse.json({
    citations: updateCitation(id, citationId, { ...rest, text: text ?? undefined }),
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const citationId = queryId(req, "citation");
  if (citationId === null) return badRequest("citation must be a citation id.");
  if (!getDraft(id)) return notFound("No such draft.");
  return NextResponse.json({ citations: removeCitation(id, citationId) });
}
