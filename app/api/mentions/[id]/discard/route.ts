import { NextResponse } from "next/server";
import { accepted, asId, badRequest, inFlight, notFound, optionalString, readBody } from "@/lib/http";
import { db } from "@/lib/db";
import { discardEvidence, restoreEvidence, type DiscardReason, type DiscardScope } from "@/lib/audit";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/**
 * Throwing one passage out of one entry, with your reason.
 *
 * The rewrite is offered rather than forced. Discarding evidence leaves the
 * entry citing a passage that is no longer part of the record, so it does have
 * to be rebuilt eventually — but rebuilding on every single discard would cost a
 * call each while you are working through a list of six, and the last one would
 * be the only rewrite that mattered.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const mentionId = asId((await ctx.params).id);
  if (mentionId === null) return badRequest("Not a valid id.");
  const body = await readBody<{
    reason: DiscardReason;
    note?: string;
    scope?: DiscardScope;
    /** Queue the entry rewrite now. */
    rewrite?: boolean;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  const note = optionalString(body.note);
  if (note === null) return badRequest("note must be a string.");
  if (body.scope !== undefined && body.scope !== "entity" && body.scope !== "library") {
    return badRequest("scope must be 'entity' or 'library'.");
  }

  const result = discardEvidence({
    mentionId,
    reason: body.reason,
    note,
    scope: body.scope,
  });

  // "No longer here" is a missing row, not a malformed request.
  if (!result.ok) {
    return /no longer here/i.test(result.error)
      ? notFound(result.error)
      : badRequest(result.error);
  }

  let runId: number | null = null;
  if (body.rewrite) {
    const already = inFlight("entry", { entityId: result.entityId });
    if (already) {
      return accepted(already, "That entry is already being rewritten.", {
        ok: true,
        entityId: result.entityId,
      });
    }
    runId = rewriteEntry(result.entityId);
  }

  return NextResponse.json({ ok: true, entityId: result.entityId, runId });
}

/** Putting it back, and forgetting the verdict. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const mentionId = asId((await ctx.params).id);
  if (mentionId === null) return badRequest("Not a valid id.");
  const rewrite = new URL(req.url).searchParams.get("rewrite") === "1";

  const result = restoreEvidence(mentionId);
  if (!result.ok) return notFound("That passage is no longer here.");

  let runId: number | null = null;
  if (rewrite && result.entityId) {
    const already = inFlight("entry", { entityId: result.entityId });
    runId = already ?? rewriteEntry(result.entityId);
  }
  return NextResponse.json({ ok: true, entityId: result.entityId, runId });
}

function rewriteEntry(entityId: number): number {
  const name =
    (
      db().prepare("SELECT canonical_name FROM entities WHERE id=?").get(entityId) as
        | { canonical_name: string }
        | undefined
    )?.canonical_name ?? `Entity ${entityId}`;

  const runId = createRun({ kind: "entry", label: name });
  enqueue(runId, [{ kind: "entry", payload: { entityId, force: true } }]);
  kickWorker();
  return runId;
}
