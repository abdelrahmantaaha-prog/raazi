import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { discard, file, heldCount, keep, listHeld, pasteText, undo } from "@/lib/triage";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ items: listHeld(), held: heldCount() });
}

export async function POST(req: Request) {
  const body = await readBody<{
    action?: "keep" | "file" | "discard" | "undo" | "paste";
    itemIds?: number[];
    reason?: string;
    text?: string;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  // Pasting is about one article at a time — it is the paywalled one you went
  // and fetched by hand.
  if (body.action === "paste") {
    const itemId = (body.itemIds ?? [])[0];
    if (!Number.isInteger(itemId)) return badRequest("Say which item.");
    if (typeof body.text !== "string") return badRequest("Nothing was pasted.");
    try {
      const result = pasteText(itemId, body.text);
      return NextResponse.json({ ...result, items: listHeld(), held: heldCount() });
    } catch (err) {
      return badRequest((err as Error).message.slice(0, 200));
    }
  }

  const ids = (body.itemIds ?? []).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return badRequest("Say which items.");
  if (ids.length > 500) return badRequest("Five hundred at a time is the limit.");

  if (body.action === "discard") {
    const result = discard(ids, body.reason);
    return NextResponse.json({ ...result, held: heldCount(), items: listHeld() });
  }

  if (body.action === "undo") {
    const result = undo(ids);
    return NextResponse.json({ ...result, held: heldCount(), items: listHeld() });
  }

  if (body.action === "keep") {
    const result = keep(ids);
    // Keeping is the only thing here that starts spending, so it is the only
    // thing that wakes the worker.
    if (result.kept) kickWorker();
    return NextResponse.json({
      ...result,
      note: result.refused.length
        ? `${result.refused.length} had nothing behind the headline and ${
            result.refused.length === 1 ? "was" : "were"
          } left where ${result.refused.length === 1 ? "it is" : "they are"} — paste the article, then keep it.`
        : undefined,
      held: heldCount(),
      items: listHeld(),
    });
  }

  // Into the library, out of the brief. Reads and spends exactly as keep does.
  if (body.action === "file") {
    const result = file(ids);
    if (result.filed) kickWorker();
    return NextResponse.json({
      ...result,
      note: result.refused.length
        ? `${result.refused.length} had nothing behind the headline and ${
            result.refused.length === 1 ? "was" : "were"
          } left where ${result.refused.length === 1 ? "it is" : "they are"} — paste the article, then file it.`
        : undefined,
      held: heldCount(),
      items: listHeld(),
    });
  }

  return badRequest("An action of keep, file, discard or undo.");
}
