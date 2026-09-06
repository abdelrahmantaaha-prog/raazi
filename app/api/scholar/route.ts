import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { pull, search } from "@/lib/scholar";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = await readBody<{
    action?: "search" | "pull";
    question?: string;
    books?: boolean;
    papers?: boolean;
    works?: {
      title?: string;
      url?: string;
      abstract?: string;
      authors?: string[];
      year?: number | null;
      venue?: string | null;
      openAccess?: boolean;
    }[];
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  if (body.action === "pull") {
    const works = (body.works ?? [])
      .filter((w) => typeof w?.title === "string" && w.title.trim())
      .slice(0, 25) as Parameters<typeof pull>[0];
    if (!works.length) return badRequest("Nothing to pull in.");
    const result = await pull(works);
    if (result.added) kickWorker();
    return NextResponse.json(result);
  }

  const question = (body.question ?? "").trim();
  if (!question) return badRequest("Type a topic or a question.");
  if (question.length > 400) return badRequest("That is too long for a search.");

  try {
    const result = await search(question, {
      books: body.books !== false,
      papers: body.papers !== false,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message.slice(0, 300) }, { status: 502 });
  }
}
