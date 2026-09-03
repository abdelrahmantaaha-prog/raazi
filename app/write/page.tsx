import { listDrafts } from "@/lib/drafts";
import { listIdeas } from "@/lib/ideas";
import { WriteHome } from "./WriteHome";

export const dynamic = "force-dynamic";

/**
 * `/write?draft=ID` opens that draft. The Ideas page has linked here with the
 * parameter since "Make a draft" existed; the page never read it, and opened
 * whichever draft was touched last instead.
 */
export default async function WritePage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string }>;
}) {
  const wanted = Number((await searchParams).draft ?? 0) || null;
  return <WriteHome drafts={listDrafts()} ideas={listIdeas()} openDraft={wanted} />;
}
