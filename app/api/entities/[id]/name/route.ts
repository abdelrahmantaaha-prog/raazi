import { NextResponse } from "next/server";
import { asId, badRequest, exists, notFound, optionalString, readBody } from "@/lib/http";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * The heading an entry goes under.
 *
 * Only a form the sources actually used may be chosen — the list comes from the
 * recorded aliases. That keeps the rule the whole pedia rests on: what you read
 * is what a source wrote, not something typed over it later.
 *
 * Setting a name locks it, so the automatic scorer stops reconsidering it every
 * time a new mention arrives.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const parsed = await readBody<{ name?: string; unlock?: boolean }>(req);
  if (parsed === null) return badRequest("Malformed JSON body.");
  const name = optionalString(parsed.name);
  if (name === null) return badRequest("name must be a string.");
  if (!exists("entities", id)) return notFound("No such entity.");

  if (parsed.unlock) {
    db().prepare("UPDATE entities SET name_locked=0 WHERE id=?").run(id);
    return NextResponse.json({ ok: true, locked: false });
  }

  const chosen = (name ?? "").trim();
  if (!chosen) return NextResponse.json({ error: "No name given." }, { status: 400 });

  const known = db()
    .prepare("SELECT 1 AS x FROM aliases WHERE entity_id=? AND surface=?")
    .get(id, chosen);
  if (!known) {
    return NextResponse.json(
      { error: "That is not one of the forms these sources used for this entity." },
      { status: 400 }
    );
  }

  db()
    .prepare("UPDATE entities SET canonical_name=?, name_locked=1 WHERE id=?")
    .run(chosen, id);

  return NextResponse.json({ ok: true, name: chosen, locked: true });
}
