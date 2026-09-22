"use client";

import type { ReactElement } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SECTIONS, sectionFor, sectionHref } from "./sections";

/**
 * The side rail.
 *
 * This was a row of ten text links across the top, which is fine on a desktop
 * and falls apart on a phone: the labels ran off the edge of the screen as one
 * unbroken word — "LibraryWritePediaNetworkTopicsSearchQuotes" — and there
 * was no way to reach the last four. So they went down the side instead, where
 * there is room for as many as the app needs.
 *
 * Then there were fifteen of them, which is a different failure: room is not
 * shape, and a flat list of fifteen peers has to be read end to end every time
 * because nothing in it is subordinate to anything else. It is seven sections
 * now, each holding the pages that belong to it — see `sections.ts` for what
 * went where and why. No page moved: the second and third page of a section are
 * reached from the tab strip the layout draws, which costs one click and saves
 * eight lines of rail.
 *
 * Icons alone on a narrow screen, icons with labels once there is width for
 * them. Every icon keeps its label as a tooltip and as screen-reader text, so
 * the compact form loses nothing but the printing.
 */

/** One drawing per section, by id. */
const ICONS: Record<string, (p: IconProps) => ReactElement> = {
  brief: Sun,
  news: Tray,
  library: Books,
  pedia: Cards,
  write: Pen,
  search: Glass,
  settings: Gear,
};

export function Nav({ discipline }: { discipline?: string }) {
  const here = sectionFor(usePathname());

  return (
    <nav
      // Below the reader, which is z-40 and deliberately covers everything: a
      // navigation bar down the side of a book is exactly the distraction
      // reading mode exists to remove.
      className="fixed inset-y-0 left-0 z-30 flex w-14 flex-col border-r border-[var(--color-rule)] bg-white/80 backdrop-blur lg:w-48"
      aria-label="Sections"
    >
      <Link
        href="/"
        className="flex h-14 shrink-0 items-center justify-center font-serif text-lg font-semibold tracking-tight lg:justify-start lg:px-4"
        title="Corpus"
      >
        <span className="lg:hidden">C</span>
        <span className="hidden lg:flex lg:min-w-0 lg:flex-col">
          <span>Corpus</span>
          {/* Which library you are in, wherever you are in it: every page
              below shows one discipline and nothing of the others, so the
              answer has to be on screen rather than in Settings. */}
          {discipline ? (
            <span className="truncate text-[0.68rem] font-normal uppercase tracking-[0.1em] text-[var(--color-muted)]">
              {discipline}
            </span>
          ) : null}
        </span>
      </Link>

      {/* Scrolls on a short screen rather than clipping the last few. */}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-3 lg:px-2">
        {SECTIONS.map((section) => {
          // Lit for every page in the section, not only its first tab, so the
          // rail goes on saying where you are once you move along the strip.
          const active = here?.id === section.id;
          const Icon = ICONS[section.id];
          return (
            <Link
              key={section.id}
              href={sectionHref(section)}
              title={section.label}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-md px-2 py-2.5 transition lg:px-3 ${
                active
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-ink)]"
                  : "text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-ink)]"
              }`}
            >
              <span className="mx-auto lg:mx-0">
                <Icon active={active} />
              </span>
              <span className="hidden text-sm lg:inline">{section.label}</span>
              <span className="sr-only lg:hidden">{section.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * Icons, drawn inline.
 *
 * Twenty lines of SVG against an icon package that would need installing,
 * updating and tree-shaking. They share a stroke weight and a 24-unit box so
 * they read as one set, and inherit `currentColor` so the active state needs no
 * second copy of anything.
 */
type IconProps = { active?: boolean };

const box = {
  width: 19,
  height: 19,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function Sun({ active }: IconProps) {
  return (
    <svg {...box} strokeWidth={active ? 2 : 1.7}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  );
}

function Tray({ active }: IconProps) {
  return (
    <svg {...box} strokeWidth={active ? 2 : 1.7}>
      <path d="M3 13h4l2 3h6l2-3h4" />
      <path d="M5 5h14l2 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4z" />
    </svg>
  );
}

function Books({ active }: IconProps) {
  return (
    <svg {...box} strokeWidth={active ? 2 : 1.7}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H9v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
      <path d="M9 4h4.5A1.5 1.5 0 0 1 15 5.5v13a1.5 1.5 0 0 1-1.5 1.5H9z" />
      <path d="m16.5 5.2 2.6.7a1.5 1.5 0 0 1 1 1.9l-3.2 11.6" />
    </svg>
  );
}

function Pen({ active }: IconProps) {
  return (
    <svg {...box} strokeWidth={active ? 2 : 1.7}>
      <path d="M12 20h8" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" />
    </svg>
  );
}

function Cards({ active }: IconProps) {
  return (
    <svg {...box} strokeWidth={active ? 2 : 1.7}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 9v11" />
    </svg>
  );
}

function Glass({ active }: IconProps) {
  return (
    <svg {...box} strokeWidth={active ? 2 : 1.7}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m20 20-4.7-4.7" />
    </svg>
  );
}

function Gear({ active }: IconProps) {
  return (
    <svg {...box} strokeWidth={active ? 2 : 1.7}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
