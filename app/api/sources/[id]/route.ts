import fs from "node:fs";
import { NextResponse } from "next/server";
import { asId, badRequest, exists, notFound, readBody } from "@/lib/http";
import { db, tx } from "@/lib/db";
import { queueUnread } from "@/lib/reading";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Your own answers about how a source is filed, and where you are with it. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const body = await readBody<{
    shelf?: string | null;
    readingState?: string | null;
    readMode?: string | null;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  if (!exists("sources", id)) return notFound("No such source.");

  if ("readMode" in body) {
    const allowed = ["eager", "along", "shelf"];
    if (body.readMode !== null && !allowed.includes(String(body.readMode))) {
      return badRequest("readMode is eager, along or shelf.");
    }
    // Shelving does not delete what the source already contributed: those
    // quotes are cited by entries elsewhere, and silently pulling them would
    // leave a page of references to nothing. It stops from here on; deleting
    // the source is the operation that takes its evidence with it.
    db().prepare("UPDATE sources SET read_mode=? WHERE id=?").run(body.readMode ?? null, id);

    // Coming off the shelf, whatever has never been read is queued now. A
    // source that has been sitting there for a month is exactly as unread as
    // it was on the day you shelved it, so this is the only way back in.
    if (body.readMode === "eager" && queueUnread(id).queued) kickWorker();
  }

  if ("shelf" in body) {
    if (body.shelf !== null && typeof body.shelf !== "string") return badRequest("shelf must be a string.");
    const allowed = ["books", "reading", "watching"];
    db()
      .prepare("UPDATE sources SET shelf=? WHERE id=?")
      .run(body.shelf && allowed.includes(body.shelf) ? body.shelf : null, id);
  }

  if ("readingState" in body) {
    if (body.readingState !== null && typeof body.readingState !== "string") {
      return badRequest("readingState must be a string.");
    }
    // Null puts it back to being worked out from how much you have read.
    const allowed = ["reading", "finished", "unread"];
    const state = body.readingState && allowed.includes(body.readingState) ? body.readingState : null;
    db().prepare("UPDATE sources SET reading_state=? WHERE id=?").run(state, id);
  }

  return NextResponse.json({ ok: true });
}

/** What deleting a source takes with it, counted before anything is touched. */
function whatWouldGo(id: number) {
  const counts = db()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM chunks WHERE source_id=?) AS chunks,
              (SELECT COUNT(*) FROM mentions WHERE source_id=?) AS mentions,
              (SELECT COUNT(*) FROM bookmarks WHERE source_id=?) AS bookmarks,
              (SELECT COUNT(*) FROM read_passages WHERE source_id=?) AS readPassages,
              (SELECT COUNT(*) FROM runs WHERE source_id=?) AS runs`
    )
    .get(id, id, id, id, id) as {
    chunks: number;
    mentions: number;
    bookmarks: number;
    readPassages: number;
    runs: number;
  };

  // Entities whose only evidence is here go with the source; the rest stay
  // and go stale, because their entries still cite quotes about to vanish.
  const affected = db()
    .prepare(
      `SELECT e.id, e.canonical_name,
              (SELECT COUNT(*) FROM mentions m WHERE m.entity_id = e.id AND m.source_id <> ?) AS elsewhere
         FROM entities e
        WHERE e.id IN (SELECT DISTINCT entity_id FROM mentions WHERE source_id=?)`
    )
    .all(id, id) as { id: number; canonical_name: string; elsewhere: number }[];

  return {
    ...counts,
    entitiesLost: affected.filter((e) => e.elsewhere === 0).map((e) => ({ id: e.id, name: e.canonical_name })),
    entitiesStale: affected.filter((e) => e.elsewhere > 0).length,
  };
}

/**
 * Removing a source removes its chunks and mentions by cascade. Entities that
 * lose all their evidence are deleted too — an entry with nothing behind it is
 * exactly the thing this app exists to prevent. Survivors go stale, because
 * their entries still cite quotes that are no longer in the library.
 *
 * `?dry=1` answers with what would be lost and touches nothing, so a
 * confirmation can say "and 14 entities with it" rather than guess.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");

  const source = db().prepare("SELECT path FROM sources WHERE id=?").get(id) as
    | { path: string | null }
    | undefined;
  if (!source) return notFound("No such source.");

  const loss = whatWouldGo(id);
  if (new URL(req.url).searchParams.get("dry") === "1") {
    return NextResponse.json({ dry: true, ...loss });
  }

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

  if (source.path && fs.existsSync(source.path)) {
    await fs.promises.unlink(source.path).catch(() => {});
  }

  return NextResponse.json({ ok: true, ...loss });
}
