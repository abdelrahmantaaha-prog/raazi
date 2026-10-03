import { NextResponse } from "next/server";
import {
  accepted,
  asId,
  badRequest,
  conflict,
  exists,
  inFlight,
  notFound,
  optionalId,
  optionalString,
  readBody,
} from "@/lib/http";
import { db, tx } from "@/lib/db";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";
import { mergeEntities } from "@/lib/pipeline/resolve";
import { refreshState } from "@/lib/pipeline/entry";
import { entityDetail } from "@/lib/queries";
import { setEntityTag } from "@/lib/tags";
import { canSearchWeb } from "@/lib/ai/client";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const detail = entityDetail(id);
  if (!detail) return notFound("No such entity.");
  return NextResponse.json(detail);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const body = await readBody<{
    action: "generate" | "webcheck" | "star" | "rename" | "merge" | "tag";
    /** For webcheck: the entry itself, or its connections. */
    scope?: "entry" | "connections";
    starred?: boolean;
    name?: string;
    disambiguator?: string | null;
    /** For merge: the entity being folded into this one. */
    otherId?: number;
    /** For tag: which tag, and whether it should apply here. */
    tagId?: number;
    on?: boolean;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  const entity = db()
    .prepare("SELECT id, canonical_name, merged_into FROM entities WHERE id=?")
    .get(id) as { id: number; canonical_name: string; merged_into: number | null } | undefined;
  // Never an empty 200: a missing entity used to fall through to
  // `entityDetail(id)` returning undefined, which serialised to nothing and
  // broke the client's JSON parse.
  if (!entity) return notFound("No such entity.");

  switch (body.action) {
    case "generate": {
      // On-demand entry for an entity below the auto threshold, or a refresh
      // of one that went stale. One at a time per entity: a second click
      // while the first is queued would write the entry twice.
      const running = inFlight("entry", { entityId: id });
      if (running) return accepted(running, "This entry is already being written.");
      const runId = createRun({ kind: "entry", label: entity.canonical_name });
      // Asking for it by hand always rewrites, even if the evidence is unchanged.
      enqueue(runId, [{ kind: "entry", payload: { entityId: id, force: true } }]);
      kickWorker();
      return NextResponse.json({ runId });
    }

    case "webcheck": {
      // The entry or its connections, against the open web. Asked for by
      // hand only: it searches on your plan's allowance.
      const scope = body.scope === "connections" ? "connections" : "entry";
      if (!canSearchWeb()) {
        return badRequest("Checking on the web needs Claude (your plan). Add it in Settings first.");
      }
      const running = inFlight("webcheck", { entityId: id, scope });
      if (running) return accepted(running, "This is already being checked.");
      const runId = createRun({
        kind: "webcheck",
        label: `Web check: ${entity.canonical_name}${scope === "connections" ? " (connections)" : ""}`,
      });
      enqueue(runId, [{ kind: "webcheck", payload: { entityId: id, scope } }]);
      kickWorker();
      return NextResponse.json({ runId });
    }

    case "star":
      db().prepare("UPDATE entities SET starred=? WHERE id=?").run(body.starred ? 1 : 0, id);
      break;

    case "tag": {
      const tagId = optionalId(body.tagId);
      if (!tagId) return badRequest("tagId required");
      if (!exists("tags", tagId)) return notFound("No such tag.");
      setEntityTag(id, tagId, body.on !== false);
      break;
    }

    case "rename": {
      // Only the fields that were sent. Renaming without resending the
      // disambiguator used to delete it.
      const name = optionalString(body.name);
      const disambiguator = body.disambiguator === null ? null : optionalString(body.disambiguator);
      if (name === null || (disambiguator === null && body.disambiguator !== null)) {
        return badRequest("name and disambiguator must be strings.");
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      if (name !== undefined && name.trim()) {
        sets.push("canonical_name=?");
        params.push(name.trim());
      }
      if (body.disambiguator !== undefined) {
        sets.push("disambiguator=?");
        params.push(disambiguator?.trim() || null);
      }
      if (sets.length) {
        db().prepare(`UPDATE entities SET ${sets.join(", ")} WHERE id=?`).run(...params, id);
      }
      break;
    }

    case "merge": {
      const otherId = optionalId(body.otherId);
      if (!otherId) return badRequest("otherId must be an entity id.");
      // A self-merge wrote a self-verdict into the resolution cache and left
      // the entity pointing at itself.
      if (otherId === id) return badRequest("An entity cannot be merged into itself.");
      const other = db()
        .prepare("SELECT normalized, merged_into FROM entities WHERE id=?")
        .get(otherId) as { normalized: string; merged_into: number | null } | undefined;
      if (!other) return notFound("No such entity to merge.");
      if (other.merged_into !== null || entity.merged_into !== null) {
        return badRequest("One of these entities has already been merged.");
      }
      tx(() => {
        mergeEntities(id, otherId, "Merged by you.", "user");
        // A user merge is a standing decision the resolver must not undo.
        const a = db().prepare("SELECT normalized, type FROM entities WHERE id=?").get(id) as
          | { normalized: string; type: string }
          | undefined;
        if (a) {
          const [x, y] =
            a.normalized < other.normalized
              ? [a.normalized, other.normalized]
              : [other.normalized, a.normalized];
          db()
            .prepare("INSERT OR REPLACE INTO resolution_verdicts (type, a_norm, b_norm, same) VALUES (?,?,?,1)")
            .run(a.type, x, y);
        }
        refreshState(id);
      });
      break;
    }

    default:
      return badRequest("Unknown action.");
  }

  const detail = entityDetail(id);
  if (!detail) return notFound("No such entity.");
  return NextResponse.json(detail);
}

/**
 * Deletes an entity.
 *
 * `merged_into` is ON DELETE SET NULL, so deleting a survivor used to bring
 * every entity folded into it back to life — as live, evidence-less entries.
 * With others merged into it the answer is 409 and the list of what would
 * come back; `?force=1` restores them deliberately, marked stale so the next
 * refresh looks at them, and then deletes.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (!exists("entities", id)) return notFound("No such entity.");
  const force = new URL(req.url).searchParams.get("force") === "1";

  const absorbed = db()
    .prepare("SELECT id, canonical_name FROM entities WHERE merged_into=?")
    .all(id) as { id: number; canonical_name: string }[];

  if (absorbed.length && !force) {
    return conflict(
      `${absorbed.length} entit${absorbed.length === 1 ? "y was" : "ies were"} merged into this one; deleting it would bring them back. Send ?force=1 to restore them and delete.`,
      { absorbed }
    );
  }

  tx(() => {
    if (absorbed.length) {
      db()
        .prepare("UPDATE entities SET merged_into=NULL, entry_state='stale' WHERE merged_into=?")
        .run(id);
      db()
        .prepare("UPDATE merge_log SET undone=1 WHERE kept_entity=? AND undone=0")
        .run(id);
    }
    db().prepare("DELETE FROM entities WHERE id=?").run(id);
  });

  return NextResponse.json({ ok: true, restored: absorbed.map((a) => a.id) });
}
