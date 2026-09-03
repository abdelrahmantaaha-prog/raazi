import { NextResponse } from "next/server";
import { badRequest, optionalString, readBody } from "@/lib/http";
import { createIdea, listIdeas } from "@/lib/ideas";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ideas: listIdeas() });
}

export async function POST(req: Request) {
  // An idea may begin as nothing but a row; an empty body is allowed.
  const body = (await readBody<{ title?: string; note?: string }>(req)) ?? {};
  const title = optionalString(body.title);
  const note = optionalString(body.note);
  if (title === null || note === null) return badRequest("title and note must be strings.");
  const id = createIdea(title ?? "", note ?? "");
  return NextResponse.json({ id, ideas: listIdeas() });
}
