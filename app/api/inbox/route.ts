import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { clipStamp, discard, file, heldCount, keep, listHeld, pasteText, undo } from "@/lib/triage";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** How much of a search is worth reading. */
const MAX_QUERY = 200;

const queryOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.slice(0, MAX_QUERY) : undefined;

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  // The inbox's watch for clips: a few bytes, asked for every few seconds.
  if (params.has("stamp")) return NextResponse.json({ stamp: clipStamp() });
  const q = queryOf(params.get("q"));
  return NextResponse.json({ items: listHeld(200, q), held: heldCount(), query: q ?? null });
}

export async function POST(req: Request) {
  const body = await readBody<{
    action?: "keep" | "file" | "discard" | "undo" | "paste";
    itemIds?: number[];
    reason?: string;
    text?: string;
    /** The search the inbox is showing, so the list it gets back is still that search. */
    q?: string;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  const q = queryOf(body.q);

  // Pasting is about one article at a time — it is the paywalled one you went
  // and fetched by hand.
  if (body.action === "paste") {
    const itemId = (body.itemIds ?? [])[0];
    if (!Number.isInteger(itemId)) return badRequest("Say which item.");
    if (typeof body.text !== "string") return badRequest("Nothing was pasted.");
    try {
      const result = pasteText(itemId, body.text);
      return NextResponse.json({ ...result, items: listHeld(200, q), held: heldCount() });
    } catch (err) {
      return badRequest((err as Error).message.slice(0, 200));
    }
  }

  const ids = (body.itemIds ?? []).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return badRequest("Say which items.");
  if (ids.length > 500) return badRequest("Five hundred at a time is the limit.");

  if (body.action === "discard") {
    const result = discard(ids, body.reason);
    return NextResponse.json({ ...result, held: heldCount(), items: listHeld(200, q) });
  }

  if (body.action === "undo") {
    const result = undo(ids);
    return NextResponse.json({ ...result, held: heldCount(), items: listHeld(200, q) });
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
      items: listHeld(200, q),
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
      items: listHeld(200, q),
    });
  }

  return badRequest("An action of keep, file, discard or undo.");
}
