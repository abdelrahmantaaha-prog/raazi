import type { ReactNode } from "react";

/**
 * A link to something outside Raazi — an article, a paper, a press release.
 *
 * Every one of them opens in the same window. Reading a wire feed means
 * opening a great many originals in a morning, and with `target="_blank"` each
 * one left a tab behind: by the time the inbox was sorted the tab bar held
 * forty articles, none of them labelled, and the app itself was somewhere
 * among them. A single reusable window is the reading desk — the article you
 * are on is on it, and the one before it is not.
 *
 * The href goes through `/read`, which severs the opener before forwarding;
 * see that route for why the two cannot be had any other way. Plain markup and
 * no JavaScript, so a middle click still opens a tab of its own when that is
 * what you meant, and nothing depends on a popup being allowed.
 */

/** The shared name. Anything using it lands in the same window. */
export const ARTICLE_WINDOW = "corpus-article";

export function articleHref(url: string): string {
  return `/read?u=${encodeURIComponent(url)}`;
}

/** "washingtonpost.com" — what a reader recognises, without the www. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function ArticleLink({
  href,
  children,
  className,
  title,
  "aria-label": ariaLabel,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  title?: string;
  "aria-label"?: string;
}) {
  return (
    <a
      href={articleHref(href)}
      target={ARTICLE_WINDOW}
      // Not "noreferrer": it implies noopener, and a browser told not to share
      // an opener stops honouring the window name and opens a fresh one every
      // time, which is the whole thing this exists to prevent. The bounce page
      // drops the opener itself and sends no referrer header.
      rel="nofollow"
      className={className}
      title={title ?? href}
      aria-label={ariaLabel}
    >
      {children}
    </a>
  );
}
