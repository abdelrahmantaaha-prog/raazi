import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { db } from "@/lib/db";
import { hasUsableKey, listKeys } from "@/lib/keys";
import { addFile, addPastedText, addUrl } from "@/lib/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const sources = db()
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM chunks c WHERE c.source_id=s.id) AS chunks,
              (SELECT COUNT(DISTINCT m.entity_id) FROM mentions m WHERE m.source_id=s.id) AS entities
         FROM sources s ORDER BY s.id DESC`
    )
    .all();
  return NextResponse.json({ sources });
}

export async function POST(req: Request) {
  if (listKeys().length === 0) {
    return NextResponse.json(
      { error: "Add a Gemini API key in Settings first — ingestion needs one." },
      { status: 401 }
    );
  }
  // Every key being spent is not a reason to refuse the source: it is queued,
  // and the run picks it up when a key comes back.
  if (!hasUsableKey()) {
    return NextResponse.json(
      {
        error:
          "Every key is currently out of quota. Add another in Settings, or wait — queued work resumes on its own.",
      },
      { status: 429 }
    );
  }

  try {
    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "No file received." }, { status: 400 });
      }
      const budget = Number(form.get("budgetCap") ?? 0) || null;
      const result = await addFile({
        filename: file.name,
        bytes: Buffer.from(await file.arrayBuffer()),
        title: String(form.get("title") ?? "") || undefined,
        author: String(form.get("author") ?? "") || undefined,
        budgetCap: budget,
      });
      return NextResponse.json(result);
    }

    const body = await readBody<{
      url?: string;
      text?: string;
      title?: string;
      author?: string;
      budgetCap?: number;
    }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

    if (body.url?.trim()) {
      return NextResponse.json(
        await addUrl({
          url: body.url.trim(),
          title: body.title,
          budgetCap: body.budgetCap ?? null,
        })
      );
    }
    if (body.text?.trim()) {
      return NextResponse.json(
        await addPastedText({
          title: body.title?.trim() || "Pasted text",
          author: body.author,
          text: body.text,
          budgetCap: body.budgetCap ?? null,
        })
      );
    }
    return NextResponse.json({ error: "Provide a file, a URL, or some text." }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "Could not add that source." },
      { status: 500 }
    );
  }
}
