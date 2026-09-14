import os from "node:os";
import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { recordCheckin } from "@/lib/follow";

export const dynamic = "force-dynamic";

/** A follower saying it is there, and whether it is about to send work back. */
export async function POST(req: Request) {
  if (!/^application\/json/i.test(req.headers.get("content-type") ?? "")) {
    return NextResponse.json({ error: "Send JSON." }, { status: 415 });
  }
  const body = await readBody<{ host?: string; bringingWork?: boolean }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  if (typeof body.host !== "string" || !body.host.trim()) return badRequest("Say which computer this is.");
  recordCheckin({ host: body.host, bringingWork: body.bringingWork === true });
  return NextResponse.json({ ok: true, host: os.hostname() });
}
