import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { alignedPairs, translationsOf } from "@/lib/translations";
import { Bilingual } from "./Bilingual";

export const dynamic = "force-dynamic";

/**
 * A book beside its translation.
 *
 * Laid out as two columns that scroll as one, because the whole point is that
 * your eye crosses between them: a passage and its rendering on the same line
 * of the screen. Where the translator joined two paragraphs or split one, the
 * row holds however many each side needed — which is why this is a list of
 * matched passages rather than two documents side by side, and why a
 * translation that drops a paragraph shows the gap instead of silently
 * shifting everything below it out of step.
 */
export default async function BilingualPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ with?: string }>;
}) {
  const id = Number((await params).id);
  const wanted = Number((await searchParams).with ?? 0) || null;

  const source = db().prepare("SELECT id, title, author, lang FROM sources WHERE id=?").get(id) as
    | { id: number; title: string; author: string | null; lang: string | null }
    | undefined;
  if (!source) notFound();

  const translations = translationsOf(id);
  if (!translations.length) {
    return (
      <div className="mx-auto max-w-2xl py-10 text-center">
        <h1 className="font-serif text-2xl font-semibold">{source.title}</h1>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          No translation is paired with this book yet. Add the translation to your library as its own
          source, then pair it from the book&rsquo;s page.
        </p>
        <Link href={`/sources/${id}`} className="mt-4 inline-block text-sm text-[var(--color-accent)] hover:underline">
          Back to the book
        </Link>
      </div>
    );
  }

  const chosen = translations.find((t) => t.id === wanted) ?? translations[0];
  const other = db().prepare("SELECT id, title, lang FROM sources WHERE id=?").get(chosen.id) as {
    id: number;
    title: string;
    lang: string | null;
  };

  return (
    <Bilingual
      original={{ id: source.id, title: source.title, lang: source.lang }}
      translation={{ id: other.id, title: other.title, lang: other.lang }}
      others={translations.map((t) => ({ id: t.id, title: t.title }))}
      pairs={alignedPairs(id, chosen.id)}
      covered={chosen.covered}
    />
  );
}
