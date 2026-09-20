import { NextResponse } from "next/server";
import { asId, badRequest, notFound, optionalId, readBody } from "@/lib/http";
import { db } from "@/lib/db";
import { alignTranslation, translationsOf, unlinkTranslation } from "@/lib/translations";

export const dynamic = "force-dynamic";

/**
 * The translations of a book, and the matching between them.
 *
 * Pairing is a POST rather than something the ingest does, because a
 * translation is a source in its own right: you add it the way you add any
 * book, and then say what it is a translation of. Doing it the other way
 * round would mean a second ingest path to keep working.
 *
 * The matching itself is deterministic and takes milliseconds over a whole
 * book, so it runs here rather than going through the queue. Nothing is sent
 * to a model — see lib/translations.ts.
 */

function sourceExists(id: number): boolean {
  return Boolean(db().prepare("SELECT 1 FROM sources WHERE id=?").get(id));
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (!sourceExists(id)) return notFound("No such source.");
  return NextResponse.json({ translations: translationsOf(id) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (!sourceExists(id)) return notFound("No such source.");

  const body = await readBody<{ translationId?: unknown }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  const translationId = optionalId(body.translationId);
  if (translationId === null || translationId === undefined) {
    return badRequest("translationId must be an id.");
  }
  if (!sourceExists(translationId)) return notFound("No such translation.");

  try {
    const result = alignTranslation(id, translationId);
    return NextResponse.json({ ...result, translations: translationsOf(id) });
  } catch (err) {
    return badRequest((err as Error).message);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const translationId = optionalId(new URL(req.url).searchParams.get("translationId"));
  if (translationId === null || translationId === undefined) {
    return badRequest("translationId must be an id.");
  }
  unlinkTranslation(translationId);
  return NextResponse.json({ translations: translationsOf(id) });
}
