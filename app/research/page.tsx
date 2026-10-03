import { findCounts, listFinds } from "@/lib/research/finds";
import { ResearchInbox } from "./ResearchInbox";

export const dynamic = "force-dynamic";

export default async function ResearchPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const asked = (await searchParams).show;
  const show = asked === "kept" || asked === "dismissed" ? asked : "new";
  return <ResearchInbox finds={listFinds(show)} counts={findCounts()} show={show} />;
}
