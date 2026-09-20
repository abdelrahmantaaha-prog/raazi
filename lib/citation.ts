/**
 * One place that assembles a citation, so the entry page, the quote bank, and
 * every export agree on what one looks like.
 *
 * A single-section source labels its only passage with that section's heading,
 * which is often the title of the source itself — hence the de-duplication,
 * without which citations read "A Revisionist Account, A Revisionist Account".
 *
 * The outlet belongs in it. A reference to reporting is the publication as
 * much as the byline — "Amy B Wang, California governor signs order pushing
 * for an AI 'kill switch'" names a person and a headline and leaves out the
 * one thing a reader needs to weigh it. Until 20 September 2026 this function
 * had no outlet parameter at all, so no citation anywhere in the app carried
 * one; the cite dialog patched its own display by appending the outlet after
 * the string, which meant the version you read and the version that reached
 * the draft were different.
 *
 * It is dropped when it repeats the author, which is the ordinary case for a
 * wire story filed under the outlet's own name ("Reuters, Reuters").
 */
export function formatCitation(parts: {
  author?: string | null;
  title: string;
  year?: string | null;
  locator?: string | null;
  outlet?: string | null;
}): string {
  const locator =
    parts.locator && parts.locator.trim() && parts.locator.trim() !== parts.title.trim()
      ? parts.locator.trim()
      : null;

  const author = parts.author?.trim() || null;
  const outlet = parts.outlet?.trim() || null;
  const publication = outlet && !same(outlet, author) && !same(outlet, parts.title) ? outlet : null;

  return [author, parts.title, publication, parts.year, locator].filter(Boolean).join(", ");
}

/** Two names for the same thing, give or take case and a leading "The". */
function same(a: string | null, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const bare = (s: string) => s.trim().toLowerCase().replace(/^the\s+/, "");
  return bare(a) === bare(b);
}
