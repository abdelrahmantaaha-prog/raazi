import { NextResponse } from "next/server";
import { accepted, asId, badRequest, inFlight, notFound, readBody } from "@/lib/http";
import { db } from "@/lib/db";
import { canSearchWeb } from "@/lib/ai/client";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";
import { readMeta } from "@/lib/source-meta";
import type { ShippingMeta } from "@/lib/pipeline/shipment";

export const dynamic = "force-dynamic";

/**
 * Looks one shipment of a shipping paper up on the open web and in public
 * records. Asked for by hand only: it searches on your plan's allowance.
 * See lib/pipeline/shipcheck.ts.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const source = db().prepare("SELECT id, title FROM sources WHERE id=?").get(id) as
    | { id: number; title: string }
    | undefined;
  if (!source) return notFound("No such source.");

  const body = await readBody<{ shipment?: unknown }>(req);
  const shipment = Number(body?.shipment ?? 0);
  const record = (readMeta(id).shipping as ShippingMeta | undefined)?.shipments?.[shipment];
  if (!Number.isInteger(shipment) || !record) return notFound("That paper records no such shipment.");
  if (!canSearchWeb()) return badRequest("Checking online needs Claude (your plan). Add it in Settings first.");

  const running = inFlight("shipcheck", { sourceId: id, shipment });
  if (running) return accepted(running, "This shipment is already being checked.");
  const runId = createRun({ kind: "webcheck", label: `Shipment check: ${record.name}` });
  enqueue(runId, [{ kind: "shipcheck", payload: { sourceId: id, shipment } }]);
  kickWorker();
  return NextResponse.json({ runId });
}
