import Link from "next/link";
import { notFound } from "next/navigation";
import { storyDetail } from "@/lib/stories";
import { ENTITY_LABEL, type EntityType } from "@/lib/types";
import { formatDateTime } from "@/lib/dates";
import { StoryActions } from "./StoryActions";

export const dynamic = "force-dynamic";

export default async function StoryPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const story = Number.isInteger(id) && id > 0 ? storyDetail(id) : undefined;
  if (!story) notFound();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Story</p>
          <h1 className="font-serif text-2xl font-semibold">{story.title}</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {story.accounts} account{story.accounts === 1 ? "" : "s"}, first seen {formatDateTime(story.first_seen)}
            {story.named_by === "user" ? " · named by you" : ""}
          </p>
        </div>
        <StoryActions id={story.id} title={story.title} pinned={Boolean(story.pinned)} />
      </header>

      <section>
        <h2 className="font-serif text-lg font-semibold">Accounts</h2>
        <ul className="mt-2 divide-y divide-[var(--color-rule)]">
          {story.accounts_list.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
              <span className="min-w-0">
                <Link href={`/sources/${a.id}`} className="hover:text-[var(--color-accent)]">
                  {a.title}
                </Link>
                <span className="ml-2 text-xs text-[var(--color-muted)]">
                  {[a.outlet, a.author].filter(Boolean).join(", ")}
                  {a.published_at ? ` · ${formatDateTime(a.published_at)}` : ""}
                  {` · ${a.passages} passage${a.passages === 1 ? "" : "s"}`}
                </span>
              </span>
              <StoryActions id={story.id} splitSourceId={a.id} compact />
            </li>
          ))}
        </ul>
      </section>

      {story.entities.length > 0 ? (
        <section>
          <h2 className="font-serif text-lg font-semibold">Who and what it is about</h2>
          <ul className="mt-2 flex flex-wrap gap-2 text-sm">
            {story.entities.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/pedia/${e.id}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-rule)] px-2 py-0.5 hover:border-[var(--color-accent)]"
                >
                  {e.canonical_name}
                  <span className="text-xs text-[var(--color-muted)]">
                    {ENTITY_LABEL[e.type as EntityType] ?? e.type} · {e.mentions}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
