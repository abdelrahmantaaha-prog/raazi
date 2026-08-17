/**
 * One place that assembles a citation, so the entry page, the quote bank, and
 * every export agree on what one looks like.
 *
 * A single-section source labels its only passage with that section's heading,
 * which is often the title of the source itself — hence the de-duplication,
 * without which citations read "A Revisionist Account, A Revisionist Account".
 */
export function formatCitation(parts: {
  author?: string | null;
  title: string;
  year?: string | null;
  locator?: string | null;
}): string {
  const locator =
    parts.locator && parts.locator.trim() && parts.locator.trim() !== parts.title.trim()
      ? parts.locator.trim()
      : null;

  return [parts.author, parts.title, parts.year, locator].filter(Boolean).join(", ");
}
