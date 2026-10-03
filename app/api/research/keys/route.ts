import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { publicResearchKeys, setResearchKey } from "@/lib/research/keys";

export const dynamic = "force-dynamic";

/** Which research services have a key. Never the keys themselves. */
export async function GET() {
  return NextResponse.json({ services: publicResearchKeys() });
}

/** Sets one key, or removes it with an empty value. */
export async function POST(req: Request) {
  const body = await readBody<{ id?: string; value?: string }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  if (typeof body.id !== "string" || typeof body.value !== "string") return badRequest("id and value must be strings.");
  if (body.value.length > 500) return badRequest("That is too long to be a key.");
  if (!setResearchKey(body.id, body.value)) return badRequest("Unknown service.");
  return NextResponse.json({ services: publicResearchKeys() });
}
