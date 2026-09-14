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
 * `/write?tab=starred` opens on the articles starred in the inbox.
 */
export default async function WritePage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string; tab?: string }>;
}) {
  const params = await searchParams;
  const wanted = Number(params.draft ?? 0) || null;
  const tab = TABS.find((t) => t === params.tab);
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
