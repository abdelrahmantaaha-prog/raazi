import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { pushTo } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

/** Make a peer's library a copy of this one, by asking it to pull from here. */
export async function POST(req: Request) {
  const body = await readBody<{ url?: string; token?: string; force?: boolean }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!/^https?:\/\//i.test(url) || !token) return badRequest("The peer's address and token are needed.");
  try {
    return NextResponse.json(await pushTo({ url, token }, { force: Boolean(body.force) }));
  } catch (err) {
    const message = (err as Error).message;
    const status = /already the same|changed since the last sync/.test(message) ? 409 : 500;
    return NextResponse.json({ error: message.slice(0, 500) }, { status });
  }
}
