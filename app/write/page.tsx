import { listDrafts } from "@/lib/drafts";
import { listIdeas } from "@/lib/ideas";
import { WriteHome } from "./WriteHome";

export const dynamic = "force-dynamic";

export default async function WritePage() {
  return <WriteHome drafts={listDrafts()} ideas={listIdeas()} />;
}
