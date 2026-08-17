import Link from "next/link";
import { db } from "@/lib/db";
import { formatLocator } from "@/lib/chunk";
import { formatCitation } from "@/lib/citation";
import { listTags } from "@/lib/tags";
import { TagFilter } from "../components/TagFilter";
import type { Locator } from "@/lib/types";
import { Card, Empty } from "../components/ui";
import { dirOf } from "@/lib/dir";

export const dynamic = "force-dynamic";

export default async function Quotes({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string }>;
}) {
  const tagId = Number((await searchParams).tag ?? 0) || undefined;
  const tags = listTags();

  const rows = db()
    .prepare(
      `SELECT m.id, m.quote, m.claim, e.id AS entity_id, e.canonical_name,
              s.title, s.author, s.year, c.locator_json, d.label AS doc_label
         FROM live_mentions m
         JOIN entities e ON e.id = m.entity_id
         JOIN sources  s ON s.id = m.source_id
         JOIN chunks   c ON c.id = m.chunk_id
    LEFT JOIN documents d ON d.id = c.doc_id
        WHERE m.starred = 1 AND e.merged_into IS NULL
          ${tagId ? "AND EXISTS (SELECT 1 FROM source_tags st WHERE st.source_id=s.id AND st.tag_id=@tagId)" : ""}
        ORDER BY e.canonical_name, s.id, m.id`
    )
    .all(tagId ? { tagId } : {}) as {
    id: number;
    quote: string;
    claim: string | null;
    entity_id: number;
    canonical_name: string;
    title: string;
    author: string | null;
    year: string | null;
    locator_json: string;
    doc_label: string | null;
  }[];

  const grouped = new Map<number, { name: string; rows: typeof rows }>();
  for (const r of rows) {
    if (!grouped.has(r.entity_id)) grouped.set(r.entity_id, { name: r.canonical_name, rows: [] });
    grouped.get(r.entity_id)!.rows.push(r);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-semibold">Quote bank</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Passages you starred, with citations resolved from current source metadata.
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href="/api/export?format=quotes"
            className="rounded border border-[var(--color-rule)] bg-white px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-accent-soft)]"
          >
            Export quotes
          </a>
          <a
            href="/api/export?format=bibtex"
            className="rounded border border-[var(--color-rule)] bg-white px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-accent-soft)]"
          >
            Export BibTeX
          </a>
          <a
            href="/api/export?format=markdown"
            className="rounded border border-[var(--color-rule)] bg-white px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-accent-soft)]"
          >
            Export all entries
          </a>
        </div>
      </div>

      <TagFilter tags={tags} active={tagId} basePath="/quotes" />

      {rows.length === 0 ? (
        <Empty
          title="Nothing starred yet"
          hint="Open any entry, go to its Evidence tab, and save the quotes worth keeping."
        />
      ) : (
        [...grouped.entries()].map(([entityId, group]) => (
          <Card key={entityId}>
            <Link href={`/pedia/${entityId}`} className="font-serif text-lg font-semibold hover:text-[var(--color-accent)]">
              {group.name}
            </Link>
            <ul className="mt-3 space-y-4">
              {group.rows.map((r) => (
                <li key={r.id} className="border-l-2 border-[var(--color-rule)] pl-3">
                  <p className="italic" dir={dirOf(r.quote)}>
                    “{r.quote}”
                  </p>
                  <p className="mt-1 text-sm text-[var(--color-muted)]">
                    {formatCitation({
                      author: r.author,
                      title: r.title,
                      year: r.year,
                      locator: formatLocator(JSON.parse(r.locator_json) as Locator, r.doc_label),
                    })}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
    </div>
  );
}
