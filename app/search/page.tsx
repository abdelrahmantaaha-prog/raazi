import Link from "next/link";
import { search } from "@/lib/queries";
import { listTags } from "@/lib/tags";
import { ENTITY_LABEL } from "@/lib/types";
import { Badge, Card, Empty } from "../components/ui";
import { TagFilter } from "../components/TagFilter";

export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tag?: string }>;
}) {
  const params = await searchParams;
  const q = params.q ?? "";
  const tagId = Number(params.tag ?? 0) || undefined;
  const results = q ? search(q, { tagId }) : { chunks: [], entries: [] };
  const tags = listTags();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Search</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Across the raw text of every source and every entry written from it.
        </p>
      </div>

      <TagFilter tags={tags} active={tagId} basePath="/search" extra={{ q: q || undefined }} />

      <form action="/search" className="flex gap-2">
        {tagId ? <input type="hidden" name="tag" value={tagId} /> : null}
        <input
          name="q"
          defaultValue={q}
          autoFocus
          placeholder="A name, a phrase, an idea…"
          className="w-full max-w-xl rounded border border-[var(--color-rule)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <button className="rounded bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white">
          Search
        </button>
      </form>

      {q && results.entries.length === 0 && results.chunks.length === 0 && (
        <Empty title={`Nothing found for “${q}”`} hint="Try a shorter phrase or a single name." />
      )}

      {results.entries.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-serif text-lg font-semibold">In entries</h2>
          {results.entries.map((e) => (
            <Card key={e.id}>
              <div className="flex items-center gap-2">
                <Link href={`/pedia/${e.id}`} className="font-medium hover:text-[var(--color-accent)]">
                  {e.canonical_name}
                </Link>
                <Badge>{ENTITY_LABEL[e.type] ?? e.type}</Badge>
              </div>
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                <Snippet text={e.snippet} />
              </p>
            </Card>
          ))}
        </section>
      )}

      {results.chunks.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-serif text-lg font-semibold">In sources</h2>
          {results.chunks.map((c) => (
            <Card key={c.id}>
              <div className="flex flex-wrap items-baseline gap-2 text-sm">
                <Link
                  href={`/sources/${c.source_id}?chunk=${c.id}`}
                  className="font-medium hover:text-[var(--color-accent)]"
                  title="Open the reader at this passage"
                >
                  {c.source_title}
                </Link>
                <span className="text-[var(--color-muted)]">{c.locator}</span>
                <Link
                  href={`/sources/${c.source_id}?chunk=${c.id}`}
                  className="text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)] hover:underline"
                >
                  read this passage →
                </Link>
              </div>
              <p className="mt-1 text-sm">
                <Snippet text={c.snippet} />
              </p>
            </Card>
          ))}
        </section>
      )}
    </div>
  );
}

/** FTS5 hands back matches wrapped in << >>; turn those into marks. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<<[^>]*>>)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("<<") && p.endsWith(">>") ? (
          <mark key={i} className="rounded bg-[var(--color-accent-soft)] px-0.5 text-[var(--color-accent)]">
            {p.slice(2, -2)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}
