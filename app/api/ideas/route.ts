import { NextResponse } from "next/server";
import { createIdea, listIdeas } from "@/lib/ideas";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ideas: listIdeas() });
}

export async function POST(req: Request) {
  const { title, note } = (await req.json().catch(() => ({}))) as {
    title?: string;
    note?: string;
  };
  const id = createIdea(title ?? "", note ?? "");
  return NextResponse.json({ id, ideas: listIdeas() });
}
