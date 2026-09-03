import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { formatLocator } from "@/lib/chunk";
import { listEntities } from "@/lib/queries";
import { tagsForSource } from "@/lib/tags";
import type { EntityType, Locator } from "@/lib/types";
import { readModeOf, readPassages } from "@/lib/reading";
import { SourceView } from "./SourceView";
import type { Mark, Passage } from "./Reader";

export const dynamic = "force-dynamic";

export default async function SourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ chunk?: string }>;
}) {
  const id = Number((await params).id);
  // `?chunk=ID` opens the reader at that passage — what a search hit or a
  // citation's "Read in" links to. Search hits used to point at an anchor
  // that existed nowhere, so you landed at the top of the book.
  const wantedChunk = Number((await searchParams).chunk ?? 0) || null;

  const source = db().prepare("SELECT * FROM sources WHERE id=?").get(id) as
    | {
        id: number;
        title: string;
        author: string | null;
        kind: string;
        year: string | null;
        publisher: string | null;
        url: string | null;
        status: string;
        note: string | null;
        added_at: string;
        shelf: string | null;
        bookmark_chunk: number | null;
        bookmark_offset: number | null;
        read_at: string | null;
        progress: number;
        read_mode: string | null;
      }
    | undefined;
  if (!source) notFound();

  const chunks = db()
    .prepare(
      `SELECT c.id, c.seq, c.text, c.locator_json, c.extracted_at, d.label AS doc_label
         FROM chunks c LEFT JOIN documents d ON d.id=c.doc_id
        WHERE c.source_id=? ORDER BY c.seq`
    )
    .all(id) as {
    id: number;
    seq: number;
    text: string;
    locator_json: string;
    extracted_at: string | null;
    doc_label: string | null;
  }[];

  const mentions = db()
    .prepare(
      `SELECT m.chunk_id, m.surface, m.entity_id, e.canonical_name, e.type
         FROM live_mentions m JOIN entities e ON e.id=m.entity_id
        WHERE m.source_id=? AND e.merged_into IS NULL`
    )
    .all(id) as {
    chunk_id: number;
    surface: string;
    entity_id: number;
    canonical_name: string;
    type: EntityType;
  }[];

  const byChunk = new Map<number, typeof mentions>();
  for (const m of mentions) {
    if (!byChunk.has(m.chunk_id)) byChunk.set(m.chunk_id, []);
    byChunk.get(m.chunk_id)!.push(m);
  }

  const passages: Passage[] = chunks.map((c) => ({
    id: c.id,
    seq: c.seq,
    text: c.text,
    locator: formatLocator(JSON.parse(c.locator_json) as Locator, c.doc_label),
    label: c.doc_label,
    extracted: Boolean(c.extracted_at),
    mentions: (byChunk.get(c.id) ?? []).map((m) => ({
      surface: m.surface,
      entityId: m.entity_id,
      name: m.canonical_name,
    })),
  }));

  const words = chunks.reduce((n, c) => n + c.text.split(/\s+/).length, 0);
  const unread = chunks.filter((c) => !c.extracted_at).length;

  const marks = db()
    .prepare(
      `SELECT b.id, b.chunk_id, b.offset, b.excerpt, c.seq
         FROM bookmarks b JOIN chunks c ON c.id = b.chunk_id
        WHERE b.source_id = ? ORDER BY c.seq, b.offset`
    )
    .all(id) as Mark[];

  const mode = readModeOf({ read_mode: source.read_mode, chunks: chunks.length });

  return (
    <SourceView
      source={{ ...source, words, mode }}
      initialChunk={wantedChunk && chunks.some((c) => c.id === wantedChunk) ? wantedChunk : null}
      position={{
        chunkId: source.bookmark_chunk,
        offset: source.bookmark_offset ?? 0,
        progress: source.progress ?? 0,
        read: readPassages(id),
      }}
      marks={marks}
      passages={passages}
      entities={listEntities({ sourceId: id, limit: 80 })}
      tags={tagsForSource(id)}
      unread={unread}
    />
  );
}
