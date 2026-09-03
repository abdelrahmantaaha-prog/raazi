import { NextResponse } from "next/server";
import { badRequest, optionalString, readBody } from "@/lib/http";
import { createDraft, listDrafts } from "@/lib/drafts";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ drafts: listDrafts() });
}

export async function POST(req: Request) {
  // An empty body is fine here — a draft may start untitled — but a body that
  // is not JSON is still a wrong request.
  const body = (await readBody<{ title?: string }>(req)) ?? {};
  const title = optionalString(body.title);
  if (title === null) return badRequest("title must be a string.");
  const id = createDraft(title);
  return NextResponse.json({ id, drafts: listDrafts() });
}
