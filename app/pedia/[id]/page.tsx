import { notFound } from "next/navigation";
import { citationOf, entityDetail, listEntities, type EvidenceRow } from "@/lib/queries";
import { db } from "@/lib/db";
import { listTags } from "@/lib/tags";
import { cachedPortrait, havePortraits, portraitState } from "@/lib/portraits";
import { isWatched } from "@/lib/watchlist";
import { EntityView } from "./EntityView";

export const dynamic = "force-dynamic";

/**
 * The other subjects this entry can lead to.
 *
 * Its relation neighbours plus whatever else the same passages discuss — the
 * set a body of prose about this subject is actually likely to name. Every
 * entity in the library would be both enormous and worse: a nine-thousand-name
 * alternation matched against every paragraph, linking "State" and "Union"
 * wherever they fell.
 */
function linkTargets(id: number) {
  const rows = db()
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

  if (rows.length === 0) return [];

  const aliases = db()
    .prepare(
      `SELECT entity_id, surface FROM aliases
        WHERE entity_id IN (${rows.map(() => "?").join(",")})`
    )
    .all(...rows.map((r) => r.id)) as { entity_id: number; surface: string }[];

  const by = new Map<number, string[]>();
  for (const a of aliases) {
    const list = by.get(a.entity_id) ?? [];
    list.push(a.surface);
    by.set(a.entity_id, list);
  }
  return rows.map((r) => ({ ...r, aliases: by.get(r.id) ?? [] }));
}

function toCitation(e: EvidenceRow) {
  return {
    id: e.id,
    quote: e.quote,
    citation: citationOf(e),
    sourceId: e.source_id,
    sourceTitle: e.source_title,
    locator: e.locator,
    chunkId: e.chunk_id,
  };
}

export default async function EntityPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const detail = entityDetail(id);
  if (!detail) notFound();

  // Candidates for a manual merge: same type, not this one.
  const siblings = listEntities({ type: detail.entity.type, limit: 400 })
    .filter((e) => e.id !== id)
    .map((e) => ({ id: e.id, name: e.canonical_name, mentions: e.mentions }));

  // Discarded passages are included, flagged. An entry written before you
  // rejected one still cites it, and a marker that simply vanished would leave
  // the sentence looking unsourced rather than looking wrong.
  const citations = [
    ...detail.evidence.map((e) => ({ ...toCitation(e), discarded: false })),
    ...detail.discarded.map((e) => ({ ...toCitation(e), discarded: true })),
  ];

  // Read on the server so the header knows whether to draw a picture or an
  // initial, rather than flashing one and swapping to the other.
  const state = portraitState(id);
  const portrait = {
    has: cachedPortrait(id) !== null,
    credit: { wikidata: state.wikidata, commons: state.commons, byYou: state.portraitBy === "you" },
  };
  const where =
    typeof state.lat === "number" && typeof state.lon === "number"
      ? { lat: state.lat, lon: state.lon, zoom: state.zoom, wikidata: state.wikidata }
      : null;

  return (
    <EntityView
      detail={detail}
      links={linkTargets(id)}
      citations={citations}
      siblings={siblings}
      allTags={listTags()}
      portrait={portrait}
      where={where}
      pictured={[...havePortraits()]}
      watching={isWatched(id)}
    />
  );
}
