import { NextResponse } from "next/server";
import { asId, badRequest } from "@/lib/http";
import { db } from "@/lib/db";
import { citationOf, evidenceFor } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * An entry, small enough to open beside something else.
 *
 * `entityDetail` returns the whole world — every passage, every relation, the
 * neighbour graph — which is right for the entry page and far too much to fetch
 * because someone tapped a name while reading. This returns what a panel shows:
 * the entry itself, a handful of quotes, and the names it links on to.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");

  const entity = db()
    .prepare(
      `SELECT id, type, canonical_name, disambiguator, entry_state
         FROM entities WHERE id=? AND merged_into IS NULL`
    )
    .get(id) as
    | {
        id: number;
        type: string;
        canonical_name: string;
        disambiguator: string | null;
        entry_state: string;
      }
    | undefined;

  if (!entity) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const entry = db()
    .prepare("SELECT summary, body_md, updated_at FROM entries WHERE entity_id=?")
    .get(id) as { summary: string; body_md: string; updated_at: string } | undefined;

  const evidence = evidenceFor(id);

  // The citations the body points at, so a quote can be checked without leaving
  // the panel — the same guarantee the full page makes.
  const citations = evidence.map((e) => ({
    id: e.id,
    quote: e.quote,
    citation: citationOf(e),
    sourceId: e.source_id,
    sourceTitle: e.source_title,
    locator: e.locator,
  }));

  /**
   * Names this entry can lead to.
   *
   * Its relation neighbours, plus whatever else the same passages talk about —
   * which is what makes an entry navigable rather than a dead end. Bounded, and
   * ordered by how much evidence stands behind each, so a body naming forty
   * things links the forty that are actually subjects here.
   */
  const links = db()
    .prepare(
      `SELECT e.id, e.canonical_name AS name, e.type,
              (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id = e.id) AS weight
         FROM entities e
        WHERE e.merged_into IS NULL AND e.id <> ?
          AND (
            e.id IN (SELECT to_entity   FROM relations WHERE from_entity = ?)
         OR e.id IN (SELECT from_entity FROM relations WHERE to_entity   = ?)
         OR e.id IN (
              SELECT m2.entity_id FROM live_mentions m2
               WHERE m2.chunk_id IN (SELECT chunk_id FROM live_mentions WHERE entity_id = ?)
            )
          )
        ORDER BY weight DESC
        LIMIT 120`
    )
    .all(id, id, id, id) as { id: number; name: string; type: string; weight: number }[];

  // Every surface form those entities are known by, so a body writing
  // "Ibn Saud" links the entity headed "Abdul Aziz".
  const aliasRows =
    links.length === 0
      ? []
      : (db()
          .prepare(
            `SELECT entity_id, surface FROM aliases
              WHERE entity_id IN (${links.map(() => "?").join(",")})`
          )
          .all(...links.map((l) => l.id)) as { entity_id: number; surface: string }[]);

  const aliasesBy = new Map<number, string[]>();
  for (const a of aliasRows) {
    const list = aliasesBy.get(a.entity_id) ?? [];
    list.push(a.surface);
    aliasesBy.set(a.entity_id, list);
  }

  return NextResponse.json({
    entity,
    entry: entry ?? null,
    citations,
    evidenceCount: evidence.length,
    links: links.map((l) => ({ ...l, aliases: aliasesBy.get(l.id) ?? [] })),
  });
}
