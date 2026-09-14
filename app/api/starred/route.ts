import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { listStarred, setStarred } from "@/lib/starred";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ starred: listStarred() });
}

/** Star or unstar one article: `{ sourceId, starred }`. Answers with the list. */
export async function POST(req: Request) {
  const body = await readBody<{ sourceId?: number; starred?: boolean }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  const sourceId = body.sourceId;
  if (typeof sourceId !== "number" || !Number.isInteger(sourceId) || sourceId <= 0) {
    return badRequest("Say which article.");
  }
  if (typeof body.starred !== "boolean") return badRequest("starred must be true or false.");
  if (!setStarred(sourceId, body.starred)) {
    return NextResponse.json({ error: "No such article." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, starred: listStarred() });
}
