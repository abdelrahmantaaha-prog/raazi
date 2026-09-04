import { heldCount, listHeld } from "@/lib/triage";
import { getConfig } from "@/lib/config";
import Inbox from "./Inbox";

export const dynamic = "force-dynamic";

export default function InboxPage() {
  return <Inbox initial={listHeld()} held={heldCount()} reviewOn={getConfig().feedReview} />;
}
