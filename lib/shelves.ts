/**
 * Which part of the Library a source belongs in.
 *
 * A book, an article and a lecture want to be shown differently, and the guess
 * from file type and length is only a guess: a 300-page PDF might be a bound
 * report you think of as a book, or a stack of articles you think of as notes.
 * So the guess is a default, and your answer overrides it permanently.
 */

export type Shelf = "books" | "reading" | "watching";

export const SHELVES: { id: Shelf; label: string; note: string }[] = [
  { id: "books", label: "Books & documents", note: "Shown as covers on a shelf." },
  { id: "reading", label: "Articles & notes", note: "Shown as a reading list." },
  { id: "watching", label: "Talks & recordings", note: "Shown as wide cards." },
];

export interface ShelvedSource {
  kind: string;
  words?: number;
  shelf?: string | null;
}

/** The stored choice if there is one, otherwise the guess. */
export function shelfOf(s: ShelvedSource): Shelf {
  if (s.shelf === "books" || s.shelf === "reading" || s.shelf === "watching") return s.shelf;
  return guessShelf(s);
}

export function guessShelf(s: ShelvedSource): Shelf {
  if (s.kind === "media") return "watching";
  if (s.kind === "pdf" || s.kind === "epub") return "books";
  // A long pasted document is a document, not a news item.
  if (s.kind === "text" && (s.words ?? 0) > 12000) return "books";
  return "reading";
}

/**
 * Where a book stands with you.
 *
 * Derived from what you have actually read rather than from anything you have
 * to remember to set — a book you opened and got three chapters into is
 * "reading" without being told. Note this depends on progress meaning what it
 * says: it counts passages dwelled on, not scroll position, or every book you
 * had ever flicked through would file itself as finished.
 */
export type ReadingState = "reading" | "finished" | "unread";

export const READING_STATES: { id: ReadingState; label: string }[] = [
  { id: "reading", label: "Reading" },
  { id: "unread", label: "Want to read" },
  { id: "finished", label: "Read" },
];

/** Books rarely end at the last page — indexes, notes and appendices follow. */
const FINISHED_AT = 0.95;

export interface ReadSource {
  progress?: number | null;
  reading_state?: string | null;
}

export function readingStateOf(s: ReadSource): ReadingState {
  if (s.reading_state === "reading" || s.reading_state === "finished" || s.reading_state === "unread") {
    return s.reading_state;
  }
  const p = s.progress ?? 0;
  if (p >= FINISHED_AT) return "finished";
  return p > 0.005 ? "reading" : "unread";
}
