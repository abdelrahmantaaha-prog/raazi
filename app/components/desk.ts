"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A page that fills the window and scrolls in its own panes, rather than
 * scrolling as a whole.
 *
 * Some pages here are documents and some are desks. A document scrolls: the
 * Brief, an entry, a source. A desk does not — the heading, the search and the
 * buttons stay where they are and the panes beneath them scroll separately,
 * because on a desk you are working across two things at once and losing one
 * of them off the top of the screen is the whole problem.
 *
 * The height cannot be a CSS constant: what sits above the desk differs by
 * page and changes when a heading wraps or a message appears. So it is
 * measured — what is above the desk, and what is below it — and both are
 * taken off the viewport.
 *
 * Measuring what is below matters as much as what is above, and a fixed
 * allowance for it is a guess. The writing desk has a word count and an
 * export button under the grid; the inbox has nothing; both sit inside a main
 * element with its own padding. Guessing two rem left fifteen pixels of page
 * scroll under a desk that was supposed to fit exactly. The figure is safe to
 * measure because it does not move when the desk's own height changes: grow
 * the desk by ten pixels and both the desk's bottom and the document's bottom
 * move by ten, so the distance between them is the same, and the observer
 * settles on the first pass rather than oscillating.
 *
 * `100dvh` rather than `100vh` so a phone browser's collapsing address bar
 * does not leave the last pane's foot below the fold. When `active` is false
 * — a narrow screen — it returns no height at all and the page scrolls
 * normally, which is right: two scrolling panes side by side need side by
 * side to exist.
 */
export function useDeskHeight(active: boolean, opts: { min?: string } = {}) {
  const min = opts.min ?? "30rem";
  const ref = useRef<HTMLDivElement>(null);
  /** What sits above the desk, so a heading that wraps re-measures. */
  const above = useRef<HTMLElement | null>(null);
  const [box, setBox] = useState<{ top: number; below: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!active || !el) {
      setBox(null);
      return;
    }
    const measure = () => {
      const rect = el.getBoundingClientRect();
      // Measured, not summed up the offsetParent chain: that walk misses the
      // margin a `space-y` utility puts on an ancestor.
      const top = Math.max(0, Math.round(rect.top + window.scrollY));
      const below = Math.max(
        0,
        Math.round(document.documentElement.scrollHeight - (top + rect.height))
      );
      setBox((old) => (old && old.top === top && old.below === below ? old : { top, below }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (above.current) observer.observe(above.current);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active]);

  return {
    ref,
    /** Attach to whatever sits above the desk, so a wrap re-measures. */
    headingRef: above,
    style: box ? { height: `max(${min}, calc(100dvh - ${box.top}px - ${box.below}px))` } : undefined,
  };
}
