"use client";

import { useState } from "react";
import { WritingDesk } from "./WritingDesk";
import { Ideas } from "./Ideas";
import { Starred } from "./Starred";
import type { DraftSummary } from "@/lib/drafts";
import type { IdeaSummary } from "@/lib/ideas";
import type { StarredArticle } from "@/lib/starred";

export type WriteTab = "drafts" | "ideas" | "starred";

/**
 * The halves of writing, on one page — and what you set aside to write from.
 *
 * Ideas come first in the tab order and second in the layout, which is the
 * right way round: you arrive here to work on a draft far more often than to
 * start one, so Drafts opens by default — but when you do have a thought, the
 * place to put it should not be somewhere you have to go and find. Starred is
 * the articles you marked in the inbox for a closer look, kept beside the
 * drafts they may end up in.
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
  /** The tab the URL asked for; the inbox links straight to Starred. */
  openTab?: WriteTab;
}) {
  const [tab, setTab] = useState<WriteTab>(openTab ?? "drafts");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1 border-b border-[var(--color-rule)]">
        {([
          ["drafts", `Drafts (${drafts.length})`],
          ["ideas", `Ideas & outlines (${ideas.length})`],
          ["starred", `Starred (${starred.length})`],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
              tab === id
                ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

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
