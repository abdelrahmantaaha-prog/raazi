import { NextResponse } from "next/server";
import { asId, badRequest, readBody } from "@/lib/http";
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

  const result = discardEvidence({
    mentionId,
    reason: body.reason,
    note: body.note,
    scope: body.scope,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  let runId: number | null = null;
  if (body.rewrite) runId = rewriteEntry(result.entityId);

  return NextResponse.json({ ok: true, entityId: result.entityId, runId });
}

/** Putting it back, and forgetting the verdict. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const mentionId = asId((await ctx.params).id);
  if (mentionId === null) return badRequest("Not a valid id.");
  const rewrite = new URL(req.url).searchParams.get("rewrite") === "1";

  const result = restoreEvidence(mentionId);
  if (!result.ok) return NextResponse.json({ error: "That passage is no longer here." }, { status: 404 });

  const runId = rewrite && result.entityId ? rewriteEntry(result.entityId) : null;
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
