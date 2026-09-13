import type { ReactElement, SVGProps } from "react";

/**
 * Small icons for actions, drawn inline.
 *
 * The rail draws its own seven in Nav.tsx; these are the ones a page needs
 * beside a verb — keep, discard, paste, undo, open. Same rules as the rail's:
 * a 24-unit box, one stroke weight, `currentColor`, and the shared `box` is
 * spread onto every SVG, because an SVG without a width and height renders at
 * nothing and the button around it collapses to its padding.
 *
 * Exported as plain functions rather than a lookup so a page imports exactly
 * the two or three it draws.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const box = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function svg({ size = 16, ...rest }: IconProps, children: ReactElement | ReactElement[]) {
  return (
    <svg {...box} width={size} height={size} {...rest}>
      {children}
    </svg>
  );
}

/** Keep: a tick. */
export function IconCheck(p: IconProps) {
  return svg(p, <path d="m5 12.5 4.5 4.5L19 7.5" />);
}

/** Discard: a cross. */
export function IconX(p: IconProps) {
  return svg(p, <path d="M6 6l12 12M18 6 6 18" />);
}

/** Paste: a clipboard. */
export function IconClipboard(p: IconProps) {
  return svg(p, [
    <rect key="a" x="6" y="5" width="12" height="16" rx="2" />,
    <path key="b" d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M9 11h6M9 15h6" />,
  ]);
}

/** Undo: an arrow curling back. */
export function IconUndo(p: IconProps) {
  return svg(p, [
    <path key="a" d="M9 14 4 9l5-5" />,
    <path key="b" d="M4 9h10a6 6 0 0 1 0 12h-3" />,
  ]);
}

/** Select all: two stacked ticks. */
export function IconSelectAll(p: IconProps) {
  return svg(p, [
    <path key="a" d="m3 8 3 3 5-6" />,
    <path key="b" d="m3 17 3 3 5-6" />,
    <path key="c" d="M14 8h7M14 17h7" />,
  ]);
}

/** Open on the outlet's own site. */
export function IconExternal(p: IconProps) {
  return svg(p, [
    <path key="a" d="M14 4h6v6" />,
    <path key="b" d="M20 4 10 14" />,
    <path key="c" d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />,
  ]);
}

/** Preview: an eye. */
export function IconEye(p: IconProps) {
  return svg(p, [
    <path key="a" d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />,
    <circle key="b" cx="12" cy="12" r="3" />,
  ]);
}

/** A calendar page. */
export function IconCalendar(p: IconProps) {
  return svg(p, [
    <rect key="a" x="3" y="5" width="18" height="16" rx="2" />,
    <path key="b" d="M3 10h18M8 3v4M16 3v4" />,
  ]);
}

/** A feed: the radio arcs. */
export function IconFeed(p: IconProps) {
  return svg(p, [
    <path key="a" d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14" />,
    <circle key="b" cx="6" cy="18" r="1.4" fill="currentColor" stroke="none" />,
  ]);
}

/** The week: a stack of days. */
export function IconWeek(p: IconProps) {
  return svg(p, [
    <rect key="a" x="3" y="5" width="18" height="16" rx="2" />,
    <path key="b" d="M3 10h18M8 3v4M16 3v4M7 14h2M11 14h2M15 14h2M7 18h2M11 18h2" />,
  ]);
}

/** A page of text: the article itself. */
export function IconText(p: IconProps) {
  return svg(p, [
    <path key="a" d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />,
    <path key="b" d="M14 3v5h5M8 12h8M8 16h8" />,
  ]);
}

/** Sync: two arrows chasing. */
export function IconSync(p: IconProps) {
  return svg(p, [
    <path key="a" d="M20 11a8 8 0 0 0-14.5-4.5L4 8" />,
    <path key="b" d="M4 3v5h5" />,
    <path key="c" d="M4 13a8 8 0 0 0 14.5 4.5L20 16" />,
    <path key="d" d="M20 21v-5h-5" />,
  ]);
}

/** File: into the library, not the brief — a box with its lid. */
export function IconShelf(p: IconProps) {
  return svg(p, [
    <path key="a" d="M3 8h18v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8Z" />,
    <path key="b" d="M2 5a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v3H2V5ZM10 12h4" />,
  ]);
}

/** Send: a paper plane, for handing a passage to the writing desk. */
export function IconSend(p: IconProps) {
  return svg(p, [
    <path key="a" d="M21 3 3 10.5l8 2.5 2.5 8L21 3Z" />,
    <path key="b" d="M11 13 21 3" />,
  ]);
}

/** Close: a small cross for dismissing a line. */
export function IconDismiss(p: IconProps) {
  return svg({ size: 14, ...p }, <path d="M7 7l10 10M17 7 7 17" />);
}
