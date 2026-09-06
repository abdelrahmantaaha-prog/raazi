"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isTabActive, sectionFor } from "./sections";

/**
 * The strip that took the place of eight rail entries.
 *
 * Rendered from the layout rather than from each page, so a page that gains a
 * sibling gains a tab without being edited, and the strip does not move or
 * re-animate as you cross between tabs in the same section — it stays put,
 * which is the whole difference between a tab bar and a row of links.
 *
 * Sections with one page draw nothing: Write and Settings have no second half,
 * and an empty strip above them would only be a rule across the page.
 *
 * Note that the page's own heading stays where it is. The strip says which of
 * a section's pages you are on; the heading says what the page is. On a detail
 * page — a source, a story, an entity — the strip still shows, with the tab it
 * descends from lit, which is the way back out.
 */
export function SectionTabs() {
  const path = usePathname();
  const section = sectionFor(path);
  if (!section || section.tabs.length < 2) return null;

  return (
    <nav
      className="-mt-1 mb-5 flex gap-1 overflow-x-auto border-b border-[var(--color-rule)] pb-px"
      aria-label={`${section.label} pages`}
    >
      {section.tabs.map((tab) => {
        const active = isTabActive(path, tab);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            // The lit tab's underline sits on the section rule, so the strip
            // reads as one edge with a piece of it thickened rather than as a
            // row of buttons floating above a line.
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition ${
              active
                ? "border-[var(--color-accent)] font-medium text-[var(--color-ink)]"
                : "border-transparent text-[var(--color-muted)] hover:border-[var(--color-rule)] hover:text-[var(--color-ink)]"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
