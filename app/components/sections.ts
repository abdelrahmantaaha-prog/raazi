/**
 * What the rail lists, and what sits underneath each entry.
 *
 * The rail had grown to fifteen destinations, which is a table of contents
 * rather than a navigation bar: Feeds, Search news, Books & papers, Search,
 * Inbox, Stories, Topics and Quotes all sat at the same level as the Library,
 * so choosing between them meant reading the whole list every time. Fifteen
 * peers have no shape. Seven sections, each with the two or three pages that
 * belong to it, have one.
 *
 * Nothing was removed. Every route that had a rail entry still exists at the
 * same URL and is still one click away — the click just lands on a section and
 * the section shows its own tabs. The groupings are the ones the work already
 * implies:
 *
 * - **News** is the wire desk. Feeds are the standing instructions, the Inbox
 *   is what they brought in that you have not ruled on, Stories is the same
 *   articles grouped by the event they describe. Three views of one pile.
 * - **Library** is what you own: the sources, the passages you starred out of
 *   them, and the topics you filed them under.
 * - **Pedia** is what was built from the library. The Network map is the same
 *   entities seen all at once instead of one at a time, which makes it a view
 *   of the Pedia and not a place of its own.
 * - **Search** is three searches that were three rail entries: your own text,
 *   the news, and the catalogues. They differ in what they look in, which is
 *   exactly what a tab strip is for.
 * - **Brief** is the day and the week — the same document over two windows —
 *   and the calendar of every date those documents have mentioned.
 *
 * A section's `href` is its first tab, so the rail still goes straight where it
 * always went: News opens the Inbox, Library opens the shelves.
 *
 * Kept free of JSX so the rail (which draws icons) and the tab strip (which
 * does not) can share it without one importing the other's markup.
 */

export interface Tab {
  href: string;
  label: string;
  /** Match the path exactly. Only "/" needs it; every other href is a prefix. */
  exact?: boolean;
  /**
   * Paths that belong to the tab without being under its href — a source's own
   * page lives at /sources/12 but is a page of the shelves. They light the tab
   * and the rail; they are never linked to from the strip.
   */
  also?: string[];
}

export interface Section {
  /** Keys the rail's icon table. */
  id: string;
  label: string;
  tabs: Tab[];
}

export const SECTIONS: Section[] = [
  {
    id: "brief",
    label: "Brief",
    tabs: [
      { href: "/brief", label: "Today" },
      { href: "/week", label: "This week" },
      { href: "/calendar", label: "Calendar" },
    ],
  },
  {
    id: "news",
    label: "News",
    tabs: [
      { href: "/inbox", label: "Inbox" },
      { href: "/stories", label: "Stories" },
      { href: "/feeds", label: "Feeds" },
    ],
  },
  {
    id: "library",
    label: "Library",
    tabs: [
      { href: "/", label: "Sources", exact: true, also: ["/sources"] },
      // Zips and folders brought in whole, waiting to be read or already read.
      { href: "/folders", label: "Folders" },
      { href: "/quotes", label: "Quotes" },
      { href: "/tags", label: "Topics" },
    ],
  },
  {
    id: "pedia",
    label: "Pedia",
    tabs: [
      { href: "/pedia", label: "Entries" },
      { href: "/network", label: "Network" },
      // What web checks turned up about these subjects. Apart from the news
      // inbox: this was looked for, one subject at a time.
      { href: "/research", label: "Research inbox" },
    ],
  },
  {
    id: "write",
    label: "Write",
    tabs: [{ href: "/write", label: "Write" }],
  },
  {
    id: "search",
    label: "Search",
    tabs: [
      { href: "/search", label: "Library" },
      { href: "/discover", label: "News" },
      { href: "/scholar", label: "Books & papers" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    tabs: [{ href: "/settings", label: "Settings" }],
  },
];

/** Where the rail sends you when you click the section itself. */
export function sectionHref(section: Section): string {
  return section.tabs[0].href;
}

function under(path: string, href: string, exact?: boolean): boolean {
  if (exact) return path === href;
  return path === href || path.startsWith(`${href}/`);
}

export function isTabActive(path: string, tab: Tab): boolean {
  return under(path, tab.href, tab.exact) || (tab.also?.some((h) => under(path, h)) ?? false);
}

/** The section a path belongs to, or null for a path outside all of them. */
export function sectionFor(path: string): Section | null {
  return SECTIONS.find((s) => s.tabs.some((t) => isTabActive(path, t))) ?? null;
}
