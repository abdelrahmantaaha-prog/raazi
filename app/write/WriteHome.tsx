"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { WritingDesk } from "./WritingDesk";
import { Ideas } from "./Ideas";
import { Starred } from "./Starred";
import type { DraftSummary } from "@/lib/drafts";
import type { IdeaSummary } from "@/lib/ideas";
import type { StarredArticle } from "@/lib/starred";

export type WriteTab = "drafts" | "ideas" | "starred";

const TABS: WriteTab[] = ["drafts", "ideas", "starred"];

/**
 * The halves of writing, on one page — and what you set aside to write from.
 *
 * Ideas come first in the tab order and second in the layout, which is the
 * right way round: you arrive here to work on a draft far more often than to
 * start one, so Drafts opens by default — but when you do have a thought, the
 * place to put it should not be somewhere you have to go and find. Starred is
 * the articles you marked in the inbox for a closer look, kept beside the
 * drafts they may end up in.
 *
 * Which tab is open lives in the address, and arrives here as a prop.
 *
 * It used to be `useState(openTab ?? "drafts")` and nothing else, and being
 * state *alone* broke three things. Back, after clicking into Starred, left
 * Write altogether instead of returning to Drafts. Reloading, or sending
 * yourself the link, always landed on Drafts whatever you had been reading.
 * And the inbox's "Starred" link did nothing at all when you were already on
 * this page: the initial value had been taken, and a new `?tab=` could not
 * reach it.
 *
 * So the address is now the record, the server reads it (see page.tsx for why
 * not `useSearchParams`), and the state below exists only to make the click
 * instant — it changes at once and the effect keeps it honest when the
 * address changes underneath it, which is what the inbox's link does.
 */
export function WriteHome({
  drafts,
  ideas,
  starred,
  openDraft,
  openTab,
}: {
  drafts: DraftSummary[];
  ideas: IdeaSummary[];
  starred: StarredArticle[];
  /** The draft the URL asked for, if it asked for one. */
  openDraft?: number | null;
  /** The tab the address asks for, read on the server. */
  openTab?: WriteTab;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<WriteTab>(openTab ?? "drafts");

  // The address changing is what a link from elsewhere does — this is the
  // line whose absence made the inbox's "Starred" link a no-op.
  useEffect(() => {
    if (openTab && openTab !== tab) setTab(openTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTab]);

  const go = (next: WriteTab) => {
    setTab(next);
    // push, not replace: moving between tabs is somewhere you have been, and
    // Back should bring you to the one you were on rather than off the page.
    // scroll: false keeps a long draft where you left it.
    // Drafts is the default, so it stays out of the address: /write is Drafts.
    router.push(next === "drafts" ? "/write" : `/write?tab=${next}`, { scroll: false });
  };

  return (
    <div className="space-y-5">
      {/* The same strip the layout draws over every other section — see
          SectionTabs. Write draws its own only because these three carry
          counts, and a count is the reason you would choose one. */}
      <nav
        className="-mt-1 flex gap-1 overflow-x-auto border-b border-[var(--color-rule)] pb-px"
        aria-label="Write pages"
      >
        {([
          ["drafts", `Drafts (${drafts.length})`],
          ["ideas", `Ideas & outlines (${ideas.length})`],
          ["starred", `Starred (${starred.length})`],
        ] as const).map(([id, label]) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => go(id)}
              aria-current={active ? "page" : undefined}
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition ${
                active
                  ? "border-[var(--color-accent)] font-medium text-[var(--color-ink)]"
                  : "border-transparent text-[var(--color-muted)] hover:border-[var(--color-rule)] hover:text-[var(--color-ink)]"
              }`}
            >
              {label}
            </button>
          );
        })}
      </nav>

      {/* All stay mounted: switching tabs must not throw away an unsaved
          title you were halfway through typing. */}
      <div hidden={tab !== "drafts"}>
        <WritingDesk initial={drafts} openDraft={openDraft} />
      </div>
      <div hidden={tab !== "ideas"}>
        <Ideas initial={ideas} />
      </div>
      <div hidden={tab !== "starred"}>
        <Starred initial={starred} />
      </div>
    </div>
  );
}
