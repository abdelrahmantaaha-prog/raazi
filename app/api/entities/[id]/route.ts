import { NextResponse } from "next/server";
import { asId, badRequest, readBody } from "@/lib/http";
import { db, tx } from "@/lib/db";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";
import { mergeEntities } from "@/lib/pipeline/resolve";
import { refreshState } from "@/lib/pipeline/entry";
import { entityDetail } from "@/lib/queries";
import { setEntityTag } from "@/lib/tags";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const detail = entityDetail(id);
  if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(detail);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const body = await readBody<{
    action: "generate" | "star" | "rename" | "merge" | "tag";
    starred?: boolean;
    name?: string;
    disambiguator?: string;
    /** For merge: the entity being folded into this one. */
    otherId?: number;
    /** For tag: which tag, and whether it should apply here. */
    tagId?: number;
    on?: boolean;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  switch (body.action) {
    case "generate": {
      // On-demand entry for an entity below the auto threshold, or a refresh
      // of one that went stale.
      const runId = createRun({
        kind: "entry",
        label:
          (db().prepare("SELECT canonical_name FROM entities WHERE id=?").get(id) as {
            canonical_name: string;
          } | undefined)?.canonical_name ?? `Entity ${id}`,
      });
      // Asking for it by hand always rewrites, even if the evidence is unchanged.
      enqueue(runId, [{ kind: "entry", payload: { entityId: id, force: true } }]);
      kickWorker();
      return NextResponse.json({ runId });
    }

    case "star":
      db().prepare("UPDATE entities SET starred=? WHERE id=?").run(body.starred ? 1 : 0, id);
      break;

    case "tag":
      if (!body.tagId) return NextResponse.json({ error: "tagId required" }, { status: 400 });
      setEntityTag(id, body.tagId, body.on !== false);
      break;

    case "rename":
      db()
        .prepare("UPDATE entities SET canonical_name=COALESCE(NULLIF(?,''), canonical_name), disambiguator=? WHERE id=?")
        .run(body.name?.trim() ?? "", body.disambiguator?.trim() || null, id);
      break;

    case "merge": {
      if (!body.otherId) {
        return NextResponse.json({ error: "otherId required" }, { status: 400 });
      }
      tx(() => {
        mergeEntities(id, body.otherId!, "Merged by you.", "user");
        // A user merge is a standing decision the resolver must not undo.
        const a = db().prepare("SELECT normalized, type FROM entities WHERE id=?").get(id) as
          | { normalized: string; type: string }
          | undefined;
        const b = db()
          .prepare("SELECT normalized FROM entities WHERE id=?")
          .get(body.otherId!) as { normalized: string } | undefined;
        if (a && b) {
          const [x, y] = a.normalized < b.normalized ? [a.normalized, b.normalized] : [b.normalized, a.normalized];
          db()
            .prepare("INSERT OR REPLACE INTO resolution_verdicts (type, a_norm, b_norm, same) VALUES (?,?,?,1)")
            .run(a.type, x, y);
        }
        refreshState(id);
      });
      break;
    }
  }

  return NextResponse.json(entityDetail(id));
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  db().prepare("DELETE FROM entities WHERE id=?").run(id);
  return NextResponse.json({ ok: true });
}
