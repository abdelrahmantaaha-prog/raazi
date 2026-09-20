import { Suspense } from "react";
import { listDrafts } from "@/lib/drafts";
import { listIdeas } from "@/lib/ideas";
import { listStarred } from "@/lib/starred";
import { WriteHome } from "./WriteHome";

export const dynamic = "force-dynamic";

/**
 * `/write?draft=ID` opens that draft. The Ideas page has linked here with the
 * parameter since "Make a draft" existed; the page never read it, and opened
 * whichever draft was touched last instead.
 *
 * `/write?tab=starred` opens on the articles starred in the inbox, and now
 * keeps that in the address while you are there — see WriteHome for what
 * holding it in component state had broken.
 */
export default async function WritePage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string }>;
}) {
  const params = await searchParams;
  const wanted = Number(params.draft ?? 0) || null;
  return (
    // useSearchParams needs one, even on a page rendered per request.
    <Suspense fallback={null}>
      <WriteHome
        drafts={listDrafts()}
        ideas={listIdeas()}
        starred={listStarred()}
        openDraft={wanted}
      />
    </Suspense>
  );
}
