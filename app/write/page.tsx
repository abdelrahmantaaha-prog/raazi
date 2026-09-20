import { listDrafts } from "@/lib/drafts";
import { listIdeas } from "@/lib/ideas";
import { listStarred } from "@/lib/starred";
import { WriteHome, type WriteTab } from "./WriteHome";

export const dynamic = "force-dynamic";

const TABS: WriteTab[] = ["drafts", "ideas", "starred"];

/**
 * `/write?draft=ID` opens that draft. The Ideas page has linked here with the
 * parameter since "Make a draft" existed; the page never read it, and opened
 * whichever draft was touched last instead.
 *
 * `/write?tab=starred` opens on the articles starred in the inbox, and the tab
 * stays in the address while you are there — see WriteHome for what holding it
 * in component state alone had broken.
 *
 * The tab is read here, on the server, rather than with `useSearchParams` in
 * the page below. That hook has to sit inside a Suspense boundary, and the
 * boundary did not hydrate on a hard load of /write: the markup arrived, the
 * rail hydrated around it, and everything inside — the tabs, the editor, the
 * draft itself — stayed inert, with no error to say so. Reached by a click on
 * the rail it was fine, which is why it survived a first look. This page is
 * already rendered per request and already has the parameters; passing the tab
 * down as a prop needs no boundary at all.
 */
export default async function WritePage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string; tab?: string }>;
}) {
  const params = await searchParams;
  const wanted = Number(params.draft ?? 0) || null;
  const tab = TABS.find((t) => t === params.tab) ?? "drafts";
  return (
    <WriteHome
      drafts={listDrafts()}
      ideas={listIdeas()}
      starred={listStarred()}
      openDraft={wanted}
      openTab={tab}
    />
  );
}
