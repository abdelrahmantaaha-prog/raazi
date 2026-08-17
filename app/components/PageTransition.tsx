"use client";

import { usePathname } from "next/navigation";

/**
 * Fades each page in, section by section.
 *
 * Keyed on the path, so React discards the old subtree and mounts a new one —
 * which is what makes the animation replay on every navigation rather than
 * once per session. Without the key the class sits on an element that is only
 * ever updated in place, and nothing moves after the first load.
 *
 * The stagger is done in CSS on the page's own sections rather than by
 * wrapping every page in something: a page renders one root with its sections
 * inside, so those are the elements worth arriving one after another. See
 * `.page-enter` in globals.css.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div key={path} className="page-enter">
      {children}
    </div>
  );
}
