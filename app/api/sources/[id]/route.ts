import fs from "node:fs";
import { NextResponse } from "next/server";
import { asId, badRequest, readBody } from "@/lib/http";
import { db, tx } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Your own answers about how a source is filed, and where you are with it. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const body = await readBody<{ shelf?: string | null; readingState?: string | null }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  if ("shelf" in body) {
    const allowed = ["books", "reading", "watching"];
    db()
      .prepare("UPDATE sources SET shelf=? WHERE id=?")
      .run(body.shelf && allowed.includes(body.shelf) ? body.shelf : null, id);
  }

  if ("readingState" in body) {
    // Null puts it back to being worked out from how much you have read.
    const allowed = ["reading", "finished", "unread"];
    const state = body.readingState && allowed.includes(body.readingState) ? body.readingState : null;
    db().prepare("UPDATE sources SET reading_state=? WHERE id=?").run(state, id);
  }

  return NextResponse.json({ ok: true });
}

/**
 * Removing a source removes its chunks and mentions by cascade. Entities that
 * lose all their evidence are deleted too — an entry with nothing behind it is
 * exactly the thing this app exists to prevent. Survivors go stale, because
 * their entries still cite quotes that are no longer in the library.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");

  const source = db().prepare("SELECT path FROM sources WHERE id=?").get(id) as
    | { path: string | null }
    | undefined;

  tx(() => {
    const affected = (
      db().prepare("SELECT DISTINCT entity_id FROM mentions WHERE source_id=?").all(id) as {
        entity_id: number;
      }[]
    ).map((r) => r.entity_id);

    db().prepare("DELETE FROM sources WHERE id=?").run(id);

    for (const entityId of affected) {
      const left = db()
        .prepare("SELECT COUNT(*) AS n FROM mentions WHERE entity_id=?")
        .get(entityId) as { n: number };
      if (left.n === 0) db().prepare("DELETE FROM entities WHERE id=?").run(entityId);
      else db().prepare("UPDATE entities SET entry_state='stale' WHERE id=?").run(entityId);
    }
  });

  if (source?.path && fs.existsSync(source.path)) {
    await fs.promises.unlink(source.path).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
