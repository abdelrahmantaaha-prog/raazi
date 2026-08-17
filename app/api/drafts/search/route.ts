import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { formatLocator } from "@/lib/chunk";
import { citationOf } from "@/lib/queries";
import type { Locator } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The curation pane's search. SQLite's full-text index and nothing else.
 *
 * No model reads the query, ranks the results, decides what is relevant, or
 * writes a summary of what was found. It matches words. That is the point: the
 * material you build an argument from should be material you went and found,
 * not material something else surfaced because it looked apposite.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim();
  const limit = Math.min(60, Number(params.get("limit")) || 30);

  if (q.length < 2) return NextResponse.json({ quotes: [], entries: [] });

  // Quoted terms so punctuation in the query cannot become FTS syntax.
  const match = q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, "")}"`)
    .join(" OR ");

  const quotes = db()
    .prepare(
      `WITH hits AS (
         SELECT rowid AS chunk_id, rank FROM chunks_fts
          WHERE chunks_fts MATCH @match ORDER BY rank LIMIT 200
       )
       SELECT m.id, m.quote, m.claim, m.context, m.source_id, m.chunk_id,
              e.id AS entity_id, e.canonical_name AS entity,
              s.title AS source_title, s.author AS source_author, s.year AS source_year,
              c.locator_json, d.label AS doc_label
         FROM hits
         JOIN live_mentions m ON m.chunk_id = hits.chunk_id
         JOIN entities e ON e.id = m.entity_id
         JOIN sources  s ON s.id = m.source_id
         JOIN chunks   c ON c.id = m.chunk_id
    LEFT JOIN documents d ON d.id = c.doc_id
        WHERE e.merged_into IS NULL
        ORDER BY hits.rank
        LIMIT @limit`
    )
    .all({ match, limit }) as {
    id: number;
    quote: string;
    claim: string | null;
    context: string | null;
    source_id: number;
    chunk_id: number;
    entity_id: number;
    entity: string;
    source_title: string;
    source_author: string | null;
    source_year: string | null;
    locator_json: string;
    doc_label: string | null;
  }[];

  const entries = db()
    .prepare(
      `SELECT e.id, e.canonical_name, e.type,
              snippet(entries_fts, 1, '<<', '>>', ' … ', 26) AS snippet
         FROM entries_fts
         JOIN entities e ON e.id = entries_fts.rowid
        WHERE entries_fts MATCH @match AND e.merged_into IS NULL
        ORDER BY rank LIMIT @limit`
    )
    .all({ match, limit: Math.min(12, limit) }) as {
    id: number;
    canonical_name: string;
    type: string;
    snippet: string;
  }[];

  return NextResponse.json({
    quotes: quotes.map((r) => {
      const locator = formatLocator(JSON.parse(r.locator_json) as Locator, r.doc_label);
      return {
        ...r,
        locator,
        citation: citationOf({
          source_author: r.source_author,
          source_title: r.source_title,
          source_year: r.source_year,
          locator,
        }),
      };
    }),
    // Citation markers are machinery, not prose; they have no place in a snippet.
    entries: entries.map((e) => ({ ...e, snippet: e.snippet.replace(/\[\[m:\d+\]\]/g, "") })),
  });
}
