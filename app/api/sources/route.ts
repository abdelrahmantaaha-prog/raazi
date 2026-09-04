import { NextResponse } from "next/server";
import { badRequest, optionalString, readBody, tooLarge } from "@/lib/http";
import { db } from "@/lib/db";
import { hasUsableKey, listKeys } from "@/lib/keys";
import { addFile, addPastedText, addUrl } from "@/lib/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The largest upload accepted. A scanned book runs to tens of megabytes; two
 * hundred is comfortably past that and comfortably short of "the whole body
 * buffered in memory with no limit", which is what this route used to be.
 */
const MAX_UPLOAD = 200 * 1024 * 1024;

export async function GET() {
  const sources = db()
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM chunks c WHERE c.source_id=s.id) AS chunks,
              (SELECT COUNT(DISTINCT m.entity_id) FROM mentions m WHERE m.source_id=s.id) AS entities
         FROM sources s
        WHERE s.triage IS NULL OR s.triage = 'kept'
        ORDER BY s.id DESC`
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

  // Refused on the declared size before a byte is read, and on the real size
  // after — a client that lies about the first still meets the second.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD) return tooLarge(MAX_UPLOAD);

  try {
    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "No file received." }, { status: 400 });
      }
      if (file.size > MAX_UPLOAD) return tooLarge(MAX_UPLOAD);
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.length > MAX_UPLOAD) return tooLarge(MAX_UPLOAD);
      const budget = Number(form.get("budgetCap") ?? 0) || null;
      const formPublished = String(form.get("publishedAt") ?? "") || undefined;
      if (formPublished && Number.isNaN(Date.parse(formPublished))) {
        return badRequest("publishedAt must be a date.");
      }
      const result = await addFile({
        filename: file.name,
        bytes,
        title: String(form.get("title") ?? "") || undefined,
        author: String(form.get("author") ?? "") || undefined,
        budgetCap: budget,
        publishedAt: formPublished,
        outlet: String(form.get("outlet") ?? "") || undefined,
      });
      return NextResponse.json(result);
    }

    const body = await readBody<{
      url?: string;
      text?: string;
      title?: string;
      author?: string;
      budgetCap?: number;
      /** Provenance a feed knows and a paste does not. */
      publishedAt?: string;
      outlet?: string;
    }>(req);
    if (body === null) return badRequest("Malformed JSON body.");

    const url = optionalString(body.url);
    const text = optionalString(body.text);
    const title = optionalString(body.title);
    const author = optionalString(body.author);
    const publishedAt = optionalString(body.publishedAt);
    const outlet = optionalString(body.outlet);
    if (url === null || text === null || title === null || author === null) {
      return badRequest("url, text, title and author must be strings.");
    }
    if (publishedAt === null || outlet === null) {
      return badRequest("publishedAt and outlet must be strings.");
    }
    // A date nothing can sort by is worse than no date: it would show on the
    // citation as written and order the timeline wrongly.
    if (publishedAt && Number.isNaN(Date.parse(publishedAt))) {
      return badRequest("publishedAt must be a date.");
    }
    if (text && text.length > MAX_UPLOAD) return tooLarge(MAX_UPLOAD);
    const budgetCap =
      body.budgetCap === undefined || body.budgetCap === null
        ? null
        : typeof body.budgetCap === "number" && body.budgetCap >= 0
          ? body.budgetCap
          : NaN;
    if (Number.isNaN(budgetCap)) return badRequest("budgetCap must be a non-negative number.");

    if (url?.trim()) {
      return NextResponse.json(
        await addUrl({ url: url.trim(), title, budgetCap, publishedAt, outlet })
      );
    }
    if (text?.trim()) {
      return NextResponse.json(
        await addPastedText({
          title: title?.trim() || "Pasted text",
          author,
          text,
          budgetCap,
          publishedAt,
          outlet,
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
