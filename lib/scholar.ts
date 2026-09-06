import { Type, type Schema } from "@google/genai";
import { generateJson } from "./ai/client";
import { addPastedText, addUrl } from "./ingest";
import { db } from "./db";
import { safeFetch } from "./net";
import { alreadyHave } from "./feeds";
import { canonicalUrl } from "./ingest/meta";

/**
 * Searching the literature, as opposed to the news.
 *
 * A beat needs both and they are not the same search. The news feeds answer
 * "what happened"; this answers "what is known", which is where a question
 * belongs — the history of a border dispute, what the evidence says about
 * tariffs and employment, who has written the standard account.
 *
 * Two catalogues, both free and neither needing a key:
 *
 *   OpenAlex     — 250 million scholarly works, with abstracts, citation
 *                  counts and open-access links where they exist. The
 *                  successor to Microsoft Academic Graph.
 *   Open Library — the Internet Archive's book catalogue, for the monograph
 *                  rather than the paper.
 *
 * The model's part is deliberately small. It does not answer the question and
 * it does not judge the results: it turns a question into the two or three
 * queries a librarian would actually type, because "what does the evidence say
 * about tariffs and employment" is a bad literature search and "tariff
 * employment effects manufacturing" is a good one. That call is local, so
 * asking costs nothing but a second.
 */

export interface Work {
  kind: "paper" | "book";
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  /** Reconstructed from OpenAlex's inverted index, or the blurb for a book. */
  abstract: string | null;
  citations: number | null;
  /** Where it can actually be read, when it can be. */
  url: string | null;
  openAccess: boolean;
  doi: string | null;
  source: "openalex" | "openlibrary";
  /** Already in the library, so the UI can say so instead of offering it. */
  sourceId: number | null;
}

const QUERY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    queries: {
      type: Type.ARRAY,
      description: "Two or three literature-search queries, each 2-6 keywords, no punctuation.",
      items: { type: Type.STRING },
    },
  },
  required: ["queries"],
};

const QUERY_SYSTEM = `You turn a researcher's question into literature search queries.
Give two or three, each a short line of keywords a librarian would type into an
academic index — nouns and technical terms, no question words, no boolean
operators, no quotation marks. Prefer the terms the literature itself uses over
the ones in the question. Answer with the queries and nothing else.`;

/**
 * A question, as the two or three searches it should really be.
 *
 * Falls back to the question itself when the model is unavailable or says
 * something unusable — a worse search is much better than an error, and a
 * short phrase is already a serviceable query.
 */
export async function searchTerms(question: string): Promise<string[]> {
  const asked = question.trim();
  // Already keywords rather than a question: don't spend a call on it.
  if (asked.split(/\s+/).length <= 4 && !/\?|^(what|why|how|who|when|where|is|are|does|did)\b/i.test(asked)) {
    return [asked];
  }
  try {
    const { data } = await generateJson<{ queries: string[] }>({
      parts: [`QUESTION: ${asked}`],
      schema: QUERY_SCHEMA,
      system: QUERY_SYSTEM,
      stage: "tag",
      timeoutMs: 120_000,
    });
    const queries = (data.queries ?? [])
      .map((q) => q.replace(/["?]/g, "").trim())
      .filter((q) => q.length > 2)
      .slice(0, 3);
    return queries.length ? queries : [asked];
  } catch {
    return [asked];
  }
}

/** OpenAlex ships abstracts as a word → positions map. This puts it back. */
function deinvert(index: Record<string, number[]> | null | undefined): string | null {
  if (!index) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const at of positions) words[at] = word;
  }
  const text = words.filter(Boolean).join(" ").trim();
  return text.length > 20 ? text.slice(0, 1500) : null;
}

interface OpenAlexWork {
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  doi?: string | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  authorships?: { author?: { display_name?: string } }[];
  primary_location?: { source?: { display_name?: string } | null; landing_page_url?: string | null } | null;
  best_oa_location?: { pdf_url?: string | null; landing_page_url?: string | null } | null;
  open_access?: { is_oa?: boolean; oa_url?: string | null } | null;
}

async function openAlex(query: string, perPage: number): Promise<Work[]> {
  const url =
    `https://api.openalex.org/works?search=${encodeURIComponent(query)}` +
    `&per-page=${perPage}&sort=relevance_score:desc` +
    // A mailto puts the request in OpenAlex's polite pool, which is faster and
    // is what their terms ask for.
    `&mailto=corpus@localhost`;
  const res = await safeFetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`OpenAlex answered ${res.status}`);
  const body = (await res.json()) as { results?: OpenAlexWork[] };

  return (body.results ?? []).map((w) => {
    const oa = w.best_oa_location?.pdf_url ?? w.open_access?.oa_url ?? w.best_oa_location?.landing_page_url ?? null;
    return {
      kind: "paper" as const,
      title: (w.title ?? w.display_name ?? "(untitled)").trim(),
      authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? "").filter(Boolean).slice(0, 8),
      year: w.publication_year ?? null,
      venue: w.primary_location?.source?.display_name ?? null,
      abstract: deinvert(w.abstract_inverted_index),
      citations: w.cited_by_count ?? null,
      url: oa ?? w.primary_location?.landing_page_url ?? (w.doi ? `https://doi.org/${w.doi.replace(/^https?:\/\/doi\.org\//, "")}` : null),
      openAccess: Boolean(w.open_access?.is_oa),
      doi: w.doi ?? null,
      source: "openalex" as const,
      sourceId: null,
    };
  });
}

interface OpenLibraryDoc {
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  publisher?: string[];
  key?: string;
  first_sentence?: string[];
  ia?: string[];
}

async function openLibrary(query: string, limit: number): Promise<Work[]> {
  const url =
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${limit}` +
    `&fields=title,author_name,first_publish_year,publisher,key,first_sentence,ia`;
  const res = await safeFetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Open Library answered ${res.status}`);
  const body = (await res.json()) as { docs?: OpenLibraryDoc[] };

  return (body.docs ?? []).map((d) => ({
    kind: "book" as const,
    title: (d.title ?? "(untitled)").trim(),
    authors: (d.author_name ?? []).slice(0, 6),
    year: d.first_publish_year ?? null,
    venue: (d.publisher ?? [])[0] ?? null,
    abstract: (d.first_sentence ?? [])[0] ?? null,
    citations: null,
    // A scanned copy at the Archive is worth linking to; the catalogue page
    // otherwise, which at least says where to find it.
    url: d.ia?.length
      ? `https://archive.org/details/${d.ia[0]}`
      : d.key
        ? `https://openlibrary.org${d.key}`
        : null,
    openAccess: Boolean(d.ia?.length),
    doi: null,
    source: "openlibrary" as const,
    sourceId: null,
  }));
}

export async function search(
  question: string,
  opts: { books?: boolean; papers?: boolean; limit?: number } = {}
): Promise<{ queries: string[]; works: Work[]; problems: string[] }> {
  const wantPapers = opts.papers ?? true;
  const wantBooks = opts.books ?? true;
  const limit = opts.limit ?? 30;
  const queries = await searchTerms(question);
  const problems: string[] = [];
  const seen = new Map<string, Work>();

  for (const query of queries) {
    const jobs: Promise<Work[]>[] = [];
    if (wantPapers) jobs.push(openAlex(query, Math.ceil(limit / queries.length)));
    if (wantBooks) jobs.push(openLibrary(query, Math.ceil(limit / queries.length / 2)));

    const settled = await Promise.allSettled(jobs);
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        problems.push(String(outcome.reason).slice(0, 160));
        continue;
      }
      for (const work of outcome.value) {
        const key = (work.doi ?? work.url ?? work.title).toLowerCase();
        if (!seen.has(key)) seen.set(key, work);
      }
    }
  }

  // Sort papers by how much the field has leaned on them; books by recency.
  const works = [...seen.values()]
    .map((w) => ({ ...w, sourceId: w.url ? (alreadyHave(canonicalUrl(w.url), w.url).sourceId ?? null) : null }))
    .sort((a, b) => (b.citations ?? -1) - (a.citations ?? -1) || (b.year ?? 0) - (a.year ?? 0))
    .slice(0, limit);

  return { queries, works, problems };
}

/**
 * Brings a work into the library.
 *
 * An open-access paper is fetched like any other address. Everything else
 * arrives as its abstract, and says so in its own note: an abstract is a real,
 * citable, dated record of what a paper claims, and pretending it is the paper
 * would put a citation in an entry that the paper itself does not support.
 */
export async function pull(
  works: { title: string; url?: string; abstract?: string; authors?: string[]; year?: number | null; venue?: string | null; openAccess?: boolean }[]
): Promise<{ added: number; skipped: number; failed: { title: string; error: string }[] }> {
  let added = 0;
  let skipped = 0;
  const failed: { title: string; error: string }[] = [];

  for (const work of works) {
    if (work.url && alreadyHave(canonicalUrl(work.url), work.url).sourceId) {
      skipped++;
      continue;
    }
    try {
      let sourceId: number;
      if (work.openAccess && work.url) {
        const result = await addUrl({
          url: work.url,
          title: work.title,
          outlet: work.venue ?? undefined,
          publishedAt: work.year ? `${work.year}-01-01` : undefined,
          fallbackText: [work.title, work.abstract].filter(Boolean).join("\n\n"),
        });
        sourceId = result.sourceId;
      } else {
        if (!work.abstract) throw new Error("No text to add — it is a catalogue entry only.");
        const result = await addPastedText({
          title: work.title,
          author: (work.authors ?? []).join(", ") || undefined,
          text: work.abstract,
          outlet: work.venue ?? undefined,
          publishedAt: work.year ? `${work.year}-01-01` : undefined,
        });
        sourceId = result.sourceId;
        db()
          .prepare("UPDATE sources SET note=? WHERE id=?")
          .run("The abstract only — the full text was not open access.", sourceId);
      }
      db()
        .prepare("UPDATE sources SET triage='kept', kept_at=datetime('now') WHERE id=?")
        .run(sourceId);
      added++;
    } catch (err) {
      failed.push({ title: work.title, error: (err as Error).message.slice(0, 200) });
    }
  }

  return { added, skipped, failed };
}
