import { NextResponse } from "next/server";
import { asId, badRequest, readBody } from "@/lib/http";
import { addCitation, citationsFor, removeCitation, updateCitation } from "@/lib/drafts";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  return NextResponse.json({ citations: citationsFor(id) });
}

/** Adds a reference — one of yours, or one from outside the library. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const body = await readBody<{
    origin?: "library" | "outside";
    text?: string;
    author?: string;
    title?: string;
    year?: string;
    locator?: string;
    url?: string;
    quote?: string;
    sourceId?: number;
    mentionId?: number;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  const citations = addCitation(id, {
    origin: body.origin ?? "outside",
    text: body.text,
    author: body.author ?? null,
    title: body.title ?? null,
    year: body.year ?? null,
    locator: body.locator ?? null,
    url: body.url ?? null,
    quote: body.quote ?? null,
    source_id: body.sourceId ?? null,
    mention_id: body.mentionId ?? null,
  });

  return NextResponse.json({ citations });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const { citationId, ...patch } = (await req.json()) as { citationId: number } & Record<
    string,
    unknown
  >;
  return NextResponse.json({ citations: updateCitation(id, citationId, patch) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const citationId = Number(new URL(req.url).searchParams.get("citation"));
  return NextResponse.json({ citations: removeCitation(id, citationId) });
}
