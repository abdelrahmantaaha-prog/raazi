import { NextResponse } from "next/server";
import { createDraft, listDrafts } from "@/lib/drafts";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ drafts: listDrafts() });
}

export async function POST(req: Request) {
  const { title } = (await req.json().catch(() => ({}))) as { title?: string };
  const id = createDraft(title);
  return NextResponse.json({ id, drafts: listDrafts() });
}
