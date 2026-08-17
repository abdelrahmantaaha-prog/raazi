"use client";

import { useState } from "react";
import { WritingDesk } from "./WritingDesk";
import { Ideas } from "./Ideas";
import type { DraftSummary } from "@/lib/drafts";
import type { IdeaSummary } from "@/lib/ideas";

/**
 * The two halves of writing, on one page.
 *
 * Ideas come first in the tab order and second in the layout, which is the
 * right way round: you arrive here to work on a draft far more often than to
 * start one, so Drafts opens by default — but when you do have a thought, the
 * place to put it should not be somewhere you have to go and find.
 */
export function WriteHome({
  drafts,
  ideas,
}: {
  drafts: DraftSummary[];
  ideas: IdeaSummary[];
}) {
  const [tab, setTab] = useState<"drafts" | "ideas">("drafts");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1 border-b border-[var(--color-rule)]">
        {([
          ["drafts", `Drafts (${drafts.length})`],
          ["ideas", `Ideas & outlines (${ideas.length})`],
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

      {/* Both stay mounted: switching tabs must not throw away an unsaved
          title you were halfway through typing. */}
      <div hidden={tab !== "drafts"}>
        <WritingDesk initial={drafts} />
      </div>
      <div hidden={tab !== "ideas"}>
        <Ideas initial={ideas} />
      </div>
    </div>
  );
}
