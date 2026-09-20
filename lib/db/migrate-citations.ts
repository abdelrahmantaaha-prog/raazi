import type Database from "better-sqlite3";
import { formatCitation } from "../citation";

/**
 * Gives every reference in a draft the outlet it should always have carried,
 * and the fields it was built from.
 *
 * Four buttons cite into a draft and each sent a different subset of the
 * fields, so most references landed with author, title, year and outlet all
 * null and nothing but a rendered string to show. `formatCitation` had no
 * outlet parameter at all, so even the string left out the publication — a
 * reference to reporting that named the byline and the headline and not the
 * paper. On 20 September 2026 every library citation in the live database was
 * in that state.
 *
 * Two passes, and the second is deliberately timid. The columns are filled
 * from the source, which can only add what was missing. The rendered `text` is
 * recomputed **only** when it still matches exactly what the old formatter
 * would have produced from those same fields — which means nobody has edited
 * it. A reference you corrected by hand is left alone.
 */
export function migrateCitations(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(draft_citations)").all() as { name: string }[];
  if (!cols.length) return 0;
  if (!cols.some((c) => c.name === "outlet")) {
    db.exec("ALTER TABLE draft_citations ADD COLUMN outlet TEXT");
  }

  const rows = db
    .prepare(
      `SELECT c.id, c.text, c.author, c.title, c.year, c.locator, c.url,
              s.title AS s_title, s.author AS s_author, s.year AS s_year,
              s.outlet AS s_outlet, s.url AS s_url
         FROM draft_citations c
         JOIN sources s ON s.id = c.source_id
        WHERE c.source_id IS NOT NULL`
    )
    .all() as {
    id: number;
    text: string | null;
    author: string | null;
    title: string | null;
    year: string | null;
    locator: string | null;
    url: string | null;
    s_title: string | null;
    s_author: string | null;
    s_year: string | null;
    s_outlet: string | null;
    s_url: string | null;
  }[];

  const update = db.prepare(
    `UPDATE draft_citations
        SET text=?, author=?, title=?, year=?, outlet=?, url=?
      WHERE id=?`
  );

  let filled = 0;
  for (const r of rows) {
    const author = r.author?.trim() || r.s_author?.trim() || null;
    const title = r.title?.trim() || r.s_title?.trim() || null;
    const year = r.year?.trim() || r.s_year?.trim() || null;
    const outlet = r.s_outlet?.trim() || null;
    const url = r.url?.trim() || (r.s_url && /^https?:\/\//i.test(r.s_url) ? r.s_url : null);
    const locator = r.locator?.trim() || null;

    // What the old formatter would have written, before it knew about
    // outlets. Some rows carry a locator in the rendered string that was
    // never stored in the column — the shelf's Cite button passed the text
    // and nothing else — so the reconstruction is also tried with a trailing
    // segment ("…, 2026, Text"), and that segment is carried through.
    const current = (r.text ?? "").trim();
    const base = [author, title, year].filter(Boolean).join(", ");
    const withLocator = [author, title, year, locator && locator !== title ? locator : null]
      .filter(Boolean)
      .join(", ");

    let trailer: string | null = null;
    let untouched = false;
    if (current === base || current === withLocator) {
      untouched = true;
    } else if (base && current.startsWith(`${base}, `)) {
      // Exactly the old rendering plus one trailing piece. A reference edited
      // by hand does not look like this.
      trailer = current.slice(base.length + 2).trim() || null;
      untouched = true;
    }

    const text =
      untouched && title
        ? formatCitation({ author, title, year, outlet, locator: locator ?? trailer })
        : r.text;

    if (
      text === r.text &&
      author === r.author &&
      title === r.title &&
      year === r.year &&
      url === r.url &&
      outlet === null
    ) {
      continue;
    }
    update.run(text, author, title, year, outlet, url, r.id);
    filled++;
  }

  if (filled > 0) console.log(`[corpus] completed ${filled} draft citation${filled === 1 ? "" : "s"}`);
  return filled;
}
