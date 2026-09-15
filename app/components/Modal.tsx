"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A dialog that behaves like one.
 *
 * The two modals in the app were each a fixed div with a backdrop and nothing
 * else: no Escape, no focus, and — on one of them — no way to close by clicking
 * outside. This gives them the four things a dialog owes a keyboard user:
 * `role="dialog"`, focus moved inside when it opens and put back when it
 * closes, Escape to dismiss, and a backdrop that dismisses on click.
 *
 * Escape is caught in the capture phase and stopped there, because the reader
 * underneath listens for the same key on the window and would otherwise close
 * itself along with the dialog.
 *
 * Rendered into the body, not where it is written. The page wrapper's
 * entrance animation stays applied once it finishes, and an element with an
 * opacity animation is a stacking context: a dialog inside it, z-50 or not,
 * could only ever stack as high as the page — under the z-30 rail, which on a
 * phone covered the left of the inbox's sheet. React events still bubble
 * through the component tree, so a page's own key handlers see the dialog's keys.
 */
export function Modal({
  label,
  onClose,
  children,
  width = "max-w-md",
  className = "",
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** A Tailwind max-width class for the panel. */
  width?: string;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closer = useRef(onClose);
  closer.current = onClose;
  /** The body exists only in the browser; a dialog open on the server's render arrives a moment later. */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    const before = document.activeElement as HTMLElement | null;
    const el = panel.current;
    // The first control if there is one, otherwise the panel itself.
    const first = el?.querySelector<HTMLElement>(
      'input, select, textarea, button:not([aria-label="Close"]), [href], [tabindex]:not([tabindex="-1"])'
    );
    (first ?? el)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      closer.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, [mounted]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/25 p-4 pt-16 sm:p-6 sm:pt-24"
      onMouseDown={(e) => {
        // Only the backdrop itself, not a drag that started inside the panel.
        if (e.target === e.currentTarget) closer.current();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`w-full ${width} rounded-lg border border-[var(--color-rule)] bg-white p-4 shadow-xl focus:outline-none ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
