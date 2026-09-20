import { db } from "./db";
import { formatCitation } from "./citation";
import { formatLocator } from "./chunk";
import { ftsMatch, likePattern, queryWords } from "./fts";
import type { Locator } from "./types";

/**
 * Finding something to cite, anywhere in the library, from inside a draft.
 *
 * The writing pane's first search reads only the passages extraction has
 * already tied to a person or an institution, which is most of what an entry
 * is built from and a fraction of what an article says. A sentence about a
 * budget line that names nobody, or a book you remember by its title, could
 * not be found from the desk at all. This searches every source by its title,
 * author and outlet, and the whole text of every source by the full-text
 * index, and hands back the sentence a passage was found by.
 *
 * Word matching and nothing else, like everything on the desk: no model reads
 * the query or decides what is relevant.
 */

export interface CitableSource {
  id: number;
  title: string;
  author: string | null;
  year: string | null;
  outlet: string | null;
  url: string | null;
  published_at: string | null;
  /** The reference as it will read, with no locator: the source as a whole. */
  citation: string;
}

export interface CitablePassage {
  chunk_id: number;
  source_id: number;
  title: string;
  author: string | null;
  year: string | null;
  outlet: string | null;
  url: string | null;
  locator: string;
  /** The sentence the passage was found by, not the whole chunk it sits in. */
  quote: string;
  citation: string;
}

/**
 * What counts as the library here: everything read in, and any article you
 * starred for a closer look. Not what is still waiting in the inbox, and not
 * what you threw out.
 */
const IN_LIBRARY = `(s.triage IS NULL OR s.triage IN ('kept', 'filed') OR s.starred_at IS NOT NULL)`;

/** The longest quote handed back; a sentence longer than this is cut at a word. */
const MAX_QUOTE = 480;

/**
 * The sentence holding most of the words searched for — whole, and in its own
 * words, since it may be quoted. The first such sentence wins a tie.
 */
export function sentenceWith(text: string, words: string[], max = MAX_QUOTE): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentences = flat.split(/(?<=[.!?؟…])\s+(?=\S)/).filter(Boolean);
  const terms = words.map((w) => w.replace(/"/g, "").toLowerCase()).filter(Boolean);
  let best = sentences[0] ?? flat;
  let score = -1;
  for (const s of sentences) {
    const low = s.toLowerCase();
    const n = terms.filter((t) => low.includes(t)).length;
    if (n > score) {
      best = s;
      score = n;
    }
  }
  if (best.length <= max) return best;
  const cut = best.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).trimEnd()}…`;
}

export function searchCitable(
  q: string,
  opts: { sources?: number; passages?: number } = {}
): { sources: CitableSource[]; passages: CitablePassage[] } {
  const words = queryWords(q);
  if (words.join("").length < 2) return { sources: [], passages: [] };

  // Sources by name: every word in the title, the author or the outlet.
  const params: Record<string, string | number> = { limit: opts.sources ?? 12 };
  const byName = words
    .map((w, n) => {
      params[`w${n}`] = likePattern(w);
      const p = `@w${n}`;
      return `(s.title LIKE ${p} ESCAPE '\\' OR s.author LIKE ${p} ESCAPE '\\' OR s.outlet LIKE ${p} ESCAPE '\\')`;
    })
    .join(" AND ");
  const sources = (
    db()
      .prepare(
        `SELECT s.id, s.title, s.author, s.year, s.outlet, s.url, s.published_at
           FROM sources s
          WHERE ${IN_LIBRARY} AND ${byName}
          ORDER BY COALESCE(s.kept_at, s.published_at, s.added_at) DESC, s.id DESC
          LIMIT @limit`
      )
      .all(params) as Omit<CitableSource, "citation">[]
  ).map((s) => ({ ...s, citation: formatCitation({ author: s.author, title: s.title, year: s.year, outlet: s.outlet, locator: "" }) }));

  // Passages by their text: every word, the last as a prefix, best match first.
  const match = ftsMatch(words);
  let passages: CitablePassage[] = [];
  if (match) {
    try {
      const rows = db()
        .prepare(
          `SELECT c.id AS chunk_id, c.source_id, c.text, c.locator_json, d.label AS doc_label,
                  s.title, s.author, s.year, s.outlet, s.url
             FROM chunks_fts
             JOIN chunks c ON c.id = chunks_fts.rowid
             JOIN sources s ON s.id = c.source_id
        LEFT JOIN documents d ON d.id = c.doc_id
            WHERE chunks_fts MATCH @match AND ${IN_LIBRARY}
            ORDER BY rank
            LIMIT @limit`
        )
        .all({ match, limit: opts.passages ?? 30 }) as {
        chunk_id: number;
        source_id: number;
        text: string;
        locator_json: string;
        doc_label: string | null;
        title: string;
        author: string | null;
        year: string | null;
        outlet: string | null;
        url: string | null;
      }[];

      const seen = new Set<string>();
      for (const r of rows) {
        const quote = sentenceWith(r.text, words);
        // The same sentence twice — a syndicated paragraph, a repeated line — is one result.
        const key = `${r.source_id}:${quote}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let locator = "";
        try {
          locator = formatLocator(JSON.parse(r.locator_json) as Locator, r.doc_label);
        } catch {
          locator = "";
        }
        passages.push({
          chunk_id: r.chunk_id,
          source_id: r.source_id,
          title: r.title,
          author: r.author,
          year: r.year,
          outlet: r.outlet,
          url: r.url,
          locator,
          quote,
          citation: formatCitation({ author: r.author, title: r.title, year: r.year, outlet: r.outlet, locator }),
        });
      }
    } catch {
      // Something the index could not parse: the sources by name still stand.
      passages = [];
    }
  }

  return { sources, passages };
}
