import Scholar from "./Scholar";

export const dynamic = "force-dynamic";

/**
 * The other kind of search.
 *
 * The feeds and /discover answer "what happened". This answers "what is
 * known" — the standard account of a border dispute, what the evidence says
 * about tariffs and employment, who has already written the thing you are
 * about to assert. Two free catalogues, OpenAlex for papers and Open Library
 * for books, and a local model that turns your question into the queries a
 * librarian would actually type.
 */
export default function ScholarPage() {
  return <Scholar />;
}
