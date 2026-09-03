import Link from "next/link";
import { listStories } from "@/lib/stories";
import { formatDateTime, relativeDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * Running stories, newest first.
 *
 * The list a beat is actually organised by. Each row is one thing that
 * happened and every account of it your feeds carried, so "who else has this"
 * is a glance rather than a search.
 */
export default async function StoriesPage() {
  const stories = listStories({ limit: 120 });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-serif text-2xl font-semibold">Stories</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Accounts of the same development, grouped. Six outlets on one wire report is one story here, and the
          entry each of them feeds is still one entry.
        </p>
      </header>

      {stories.length === 0 ? (
        <p className="rounded border border-dashed border-[var(--color-rule)] px-4 py-6 text-sm text-[var(--color-muted)]">
          Nothing yet. Stories are grouped as articles arrive from your <Link href="/feeds" className="underline">feeds</Link>.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-rule)]">
          {stories.map((s) => (
            <li key={s.id} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link href={`/stories/${s.id}`} className="font-medium hover:text-[var(--color-accent)]">
                  {s.pinned ? "★ " : ""}
                  {s.title}
                </Link>
                <span className="text-xs text-[var(--color-muted)]" title={formatDateTime(s.last_seen)}>
                  {relativeDate(s.last_seen)}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                {s.accounts} account{s.accounts === 1 ? "" : "s"}
                {s.outlets ? ` · ${s.outlets.split(",").filter(Boolean).slice(0, 6).join(", ")}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
