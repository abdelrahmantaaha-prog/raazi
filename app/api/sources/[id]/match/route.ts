import fs from "node:fs";
import { NextResponse } from "next/server";
import { asId, badRequest, notFound, optionalString, readBody } from "@/lib/http";
import { db } from "@/lib/db";
import { COVERS_DIR, coverPath } from "@/lib/covers";

export const dynamic = "force-dynamic";

interface Doc {
  key?: string;
  cover_i?: number;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  publisher?: string[];
  number_of_pages_median?: number;
}

/**
 * Searches Open Library so a source can be matched by hand.
 *
 * The automatic lookup is deliberately strict — it would rather find nothing
 * than put a confidently wrong cover on a research source. That leaves working
 * papers, scanned reports and anything with a mangled filename unmatched, and
 * this is how you settle those yourself.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const url = new URL(req.url);

  const source = db().prepare("SELECT title, author FROM sources WHERE id=?").get(id) as
    | { title: string; author: string | null }
    | undefined;
  if (!source) return notFound("No such source.");

  // Defaults to the source's own title, so the first search is usually right.
  const q = (url.searchParams.get("q") ?? source.title)
    .replace(/\.(pdf|epub|txt|md|docx?)$/i, "")
    .replace(/[_]+/g, " ")
    .trim();
  if (q.length < 3) return NextResponse.json({ query: q, results: [] });

  const params = new URLSearchParams({
    q,
    limit: "12",
    fields: "key,cover_i,title,author_name,first_publish_year,publisher,number_of_pages_median",
  });

  try {
    const res = await fetch(`https://openlibrary.org/search.json?${params}`, {
      headers: { "user-agent": "Corpus/0.1 (personal research)" },
    });
    if (!res.ok) throw new Error(`Open Library returned ${res.status}`);
    const data = (await res.json()) as { docs?: Doc[] };

    const results = (data.docs ?? [])
      .filter((d) => d.cover_i)
      .map((d) => ({
        coverId: d.cover_i!,
        title: d.title ?? "Untitled",
        author: d.author_name?.[0] ?? null,
        year: d.first_publish_year ?? null,
        publisher: d.publisher?.[0] ?? null,
        pages: d.number_of_pages_median ?? null,
        thumb: `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`,
      }));

    return NextResponse.json({ query: q, results });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

/**
 * Accepts a chosen Open Library edition: stores its cover and, where the source
 * is missing them, its author, year and publisher — those feed citations, so an
 * empty field is worth filling and a populated one is not worth overwriting.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const body = await readBody<{
    coverId: number;
    title?: string;
    author?: string | null;
    year?: number | null;
    publisher?: string | null;
    useTitle?: boolean;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  // The cover id goes straight into an Open Library URL; it is theirs, and it
  // is a number, so anything else is a wrong request rather than a lookup.
  if (
    typeof body.coverId !== "number" ||
    !Number.isInteger(body.coverId) ||
    body.coverId <= 0 ||
    body.coverId > 1e12
  ) {
    return NextResponse.json({ error: "Pick an edition." }, { status: 400 });
  }
  for (const k of ["title", "author", "publisher"] as const) {
    if (body[k] !== undefined && body[k] !== null && optionalString(body[k]) === null) {
      return badRequest(`${k} must be a string.`);
    }
  }
  if (body.year !== undefined && body.year !== null && typeof body.year !== "number") {
    return badRequest("year must be a number.");
  }
  if (!db().prepare("SELECT 1 FROM sources WHERE id=?").get(id)) return notFound("No such source.");

  try {
    const res = await fetch(`https://covers.openlibrary.org/b/id/${body.coverId}-L.jpg`, {
      headers: { "user-agent": "Corpus/0.1 (personal research)" },
    });
    if (!res.ok) throw new Error(`Cover fetch failed (${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1500) throw new Error("That edition has no usable cover image.");

    fs.mkdirSync(COVERS_DIR, { recursive: true });
    await fs.promises.writeFile(coverPath(id), buf);

    const row = db().prepare("SELECT meta_json FROM sources WHERE id=?").get(id) as
      | { meta_json: string }
      | undefined;
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(row?.meta_json ?? "{}") as Record<string, unknown>;
    } catch {
      /* start fresh */
    }
    meta.cover = "hit";
    meta.coverBy = "you";
    meta.openLibraryCover = body.coverId;

    db()
      .prepare(
        `UPDATE sources SET
           meta_json = ?,
           title     = CASE WHEN ? THEN COALESCE(NULLIF(?,''), title) ELSE title END,
           author    = COALESCE(NULLIF(author,''), NULLIF(?,'')),
           year      = COALESCE(NULLIF(year,''), NULLIF(?,'')),
           publisher = COALESCE(NULLIF(publisher,''), NULLIF(?,''))
         WHERE id = ?`
      )
      .run(
        JSON.stringify(meta),
        body.useTitle ? 1 : 0,
        body.title ?? "",
        body.author ?? "",
        body.year ? String(body.year) : "",
        body.publisher ?? "",
        id
      );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
