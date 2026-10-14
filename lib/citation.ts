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
 *
 * Two habits of web pages are undone on the way: a byline that begins "By",
 * and a headline that ends with the site's name ("… | Statista"), which with
 * the outlet added read "…, Statista, Statista".
 */
export function formatCitation(parts: {
  author?: string | null;
  title: string;
  year?: string | null;
  locator?: string | null;
  outlet?: string | null;
}): string {
  const outlet = parts.outlet?.trim() || null;
  const title = withoutSiteName(parts.title.trim(), outlet);
  const locator =
    parts.locator && parts.locator.trim() && parts.locator.trim() !== title && parts.locator.trim() !== parts.title.trim()
      ? parts.locator.trim()
      : null;

  const author = parts.author?.trim().replace(/^by\s+/i, "") || null;
  const publication = outlet && !same(outlet, author) && !same(outlet, title) ? outlet : null;

  return [author, title, publication, parts.year?.trim() || null, locator].filter(Boolean).join(", ");
}

/** "Headline | Outlet" → "Headline", when the tail is the outlet's name. */
function withoutSiteName(title: string, outlet: string | null): string {
  if (!outlet) return title;
  const m = /^(.*\S)\s+[|–—-]\s+([^|–—-]+)$/.exec(title);
  if (!m) return title;
  const tail = m[2].trim().toLowerCase().replace(/\.(com|org|net|co\.il|co\.uk)$/, "");
  const name = outlet.toLowerCase().replace(/\.(com|org|net|co\.il|co\.uk)$/, "");
  return same(tail, name) ? m[1] : title;
}

/** Two names for the same thing, give or take case and a leading "The". */
function same(a: string | null, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const bare = (s: string) => s.trim().toLowerCase().replace(/^the\s+/, "");
  return bare(a) === bare(b);
}
