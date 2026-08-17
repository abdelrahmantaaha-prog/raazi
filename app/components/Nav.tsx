"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The side rail.
 *
 * This was a row of ten text links across the top, which is fine on a desktop
 * and falls apart on a phone: the labels ran off the edge of the screen as one
 * unbroken word — "LibraryWritePediaNetworkAskStudyTopicsSearchQu" — and there
 * was no way to reach the last four. Ten destinations do not fit across 360
 * pixels in any typography, so they go down the side instead, where there is
 * room for as many as the app ever needs.
 *
 * Icons alone on a narrow screen, icons with labels once there is width for
 * them. Every icon keeps its label as a tooltip and as screen-reader text, so
 * the compact form loses nothing but the printing.
 */

const NAV = [
  { href: "/", label: "Library", icon: Books, exact: true },
  { href: "/write", label: "Write", icon: Pen },
  { href: "/pedia", label: "Pedia", icon: Cards },
  { href: "/network", label: "Network", icon: Graph },
  { href: "/ask", label: "Ask", icon: Question },
  { href: "/study", label: "Study", icon: Cap },
  { href: "/tags", label: "Topics", icon: Tag },
  { href: "/search", label: "Search", icon: Glass },
  { href: "/quotes", label: "Quotes", icon: Quote },
  { href: "/settings", label: "Settings", icon: Gear },
];

export function Nav() {
  const path = usePathname();

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
        <span className="hidden lg:inline">Corpus</span>
      </Link>

      {/* Scrolls on a short screen rather than clipping the last few. */}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-3 lg:px-2">
        {NAV.map((n) => {
          const active = n.exact ? path === n.href : path === n.href || path.startsWith(`${n.href}/`);
          const Icon = n.icon;
          return (
            <Link
              key={n.href}
              href={n.href}
              title={n.label}
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
              <span className="hidden text-sm lg:inline">{n.label}</span>
              <span className="sr-only lg:hidden">{n.label}</span>
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

function Graph({ active }: IconProps) {
  return (
    <svg {...box} strokeWidth={active ? 2 : 1.7}>
      <circle cx="12" cy="12" r="2.4" />
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="7" r="2" />
      <circle cx="17" cy="18" r="2" />
      <path d="m6.6 7.4 3.7 3.2M17.3 8.6 13.6 11M15.6 16.6 13.4 14" />
    </svg>
  );
}

function Question({ active }: IconProps) {
  return (
    <svg {...box} strokeWidth={active ? 2 : 1.7}>
      <path d="M21 12a8.5 8.5 0 1 1-3.4-6.8" />
      <path d="M9.4 9a2.7 2.7 0 1 1 3.4 2.6c-.7.2-1 .8-1 1.5v.4" />
      <path d="M12 17.2h.01" />
    </svg>
  );
}

function Cap({ active }: IconProps) {
  return (
    <svg {...box} strokeWidth={active ? 2 : 1.7}>
      <path d="m12 4 9 4.5-9 4.5-9-4.5z" />
      <path d="M7 10.6V16c0 1.4 2.2 2.6 5 2.6s5-1.2 5-2.6v-5.4" />
    </svg>
  );
}

function Tag({ active }: IconProps) {
  return (
    <svg {...box} strokeWidth={active ? 2 : 1.7}>
      <path d="M4 4h7.2a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8l-4.8 4.8a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 4 11.2z" />
      <path d="M8.5 8.5h.01" />
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

/**
 * A quoted passage: the rule down its side, and the lines it holds.
 *
 * The obvious drawing — a pair of curly quotation marks — came out at this size
 * looking like the digits 66 sitting in the middle of a column of icons.
 */
function Quote({ active }: IconProps) {
  return (
    <svg {...box} strokeWidth={active ? 2 : 1.7}>
      <path d="M5 5.5v13" strokeWidth={active ? 2.6 : 2.2} />
      <path d="M9.5 8h10M9.5 12h10M9.5 16h6" />
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
