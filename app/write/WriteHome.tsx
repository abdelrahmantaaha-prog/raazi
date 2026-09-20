"use client";

import { useRouter, useSearchParams } from "next/navigation";
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
 * Which tab is open lives in the address, not in this component.
 *
 * It used to be `useState(openTab ?? "drafts")`, and being state rather than
 * address broke three things at once. Back, after clicking into Starred, left
 * Write altogether instead of returning to Drafts. Reloading, or sending
 * yourself the link, always landed on Drafts whatever you had been reading.
 * And the inbox's "Starred" link did nothing at all when you were already on
 * this page: the initial value had already been taken, and a new `?tab=`
 * could not reach it. Reading the parameter on every render fixes all three,
 * and costs nothing — the panes below stay mounted either way.
 */
export function WriteHome({
  drafts,
  ideas,
  starred,
  openDraft,
}: {
  drafts: DraftSummary[];
  ideas: IdeaSummary[];
  starred: StarredArticle[];
  /** The draft the URL asked for, if it asked for one. */
  openDraft?: number | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const asked = params.get("tab");
  const tab: WriteTab = TABS.find((t) => t === asked) ?? "drafts";

  const go = (next: WriteTab) => {
    const q = new URLSearchParams(params.toString());
    // Drafts is the default, so it stays out of the address: /write is Drafts.
    if (next === "drafts") q.delete("tab");
    else q.set("tab", next);
    // push, not replace: moving between tabs is somewhere you have been, and
    // Back should bring you to the one you were on rather than off the page.
    // scroll: false keeps a long draft where you left it.
    router.push(q.size ? `/write?${q}` : "/write", { scroll: false });
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
