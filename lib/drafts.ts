import { db } from "./db";
import { htmlToText } from "./richtext";

/**
 * Drafts, and the material gathered beside them.
 *
 * Everything in this file is SQL. There is no model anywhere in it, and that is
 * a design constraint rather than an accident of implementation: the point of
 * the writing desk is that the searching, the reading and the choosing are
 * yours. A suggestion engine sitting in the margin would change what you write
 * whether or not you took its advice.
 */

export interface Draft {
  id: number;
  title: string;
  /** The rich text you edit. */
  body_html: string;
  /** The same thing as plain text, for the fact-check and the word count. */
  body_md: string;
  check_json: string | null;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DraftNote {
  id: number;
  draft_id: number;
  kind: "quote" | "passage" | "entry";
  text: string;
  citation: string | null;
  note: string | null;
  entity_id: number | null;
  mention_id: number | null;
  chunk_id: number | null;
  source_id: number | null;
  seq: number;
  created_at: string;
}

export interface DraftSummary {
  id: number;
  title: string;
  updated_at: string;
  words: number;
  notes: number;
}

export function listDrafts(): DraftSummary[] {
  return db()
    .prepare(
      `SELECT d.id, d.title, d.updated_at,
              LENGTH(TRIM(d.body_md)) - LENGTH(REPLACE(TRIM(d.body_md), ' ', '')) + 1 AS words,
              (SELECT COUNT(*) FROM draft_notes n WHERE n.draft_id = d.id) AS notes
         FROM drafts d ORDER BY d.updated_at DESC`
    )
    .all() as DraftSummary[];
}

export function getDraft(id: number): Draft | undefined {
  return db().prepare("SELECT * FROM drafts WHERE id=?").get(id) as Draft | undefined;
}

export function createDraft(title = "Untitled"): number {
  return Number(
    db().prepare("INSERT INTO drafts (title) VALUES (?)").run(title.trim() || "Untitled")
      .lastInsertRowid
  );
}

/**
 * Saves a draft.
 *
 * A blank body only ever overwrites a blank body. The editor autosaves, and an
 * autosave that fires while the component is still mounting — before the text
 * has loaded into it — would otherwise wipe the file you came to work on. That
 * is not a hypothetical: it is the standard way autosaving editors lose work.
 */
export function saveDraft(
  id: number,
  patch: { title?: string; body_html?: string; body_md?: string }
): void {
  const current = getDraft(id);
  if (!current) return;

  // Whichever form was sent, an empty one never overwrites a full one. The
  // guard has to cover both paths: the editor sends HTML, but a plain-text
  // save is still how the fact-check and older drafts round-trip, and losing
  // work through the one that happens not to be guarded is no better.
  const wouldEmpty =
    patch.body_html !== undefined
      ? htmlToText(patch.body_html).trim() === ""
      : patch.body_md !== undefined && patch.body_md.trim() === "";
  const refuse = wouldEmpty && current.body_md.trim() !== "";

  const html = refuse || patch.body_html === undefined ? current.body_html : patch.body_html;

  // The plain-text form is derived from the HTML rather than sent alongside it,
  // so the two cannot drift apart.
  const text = refuse
    ? current.body_md
    : patch.body_html !== undefined
      ? htmlToText(html)
      : (patch.body_md ?? current.body_md);

  db()
    .prepare(
      "UPDATE drafts SET title=?, body_html=?, body_md=?, updated_at=datetime('now') WHERE id=?"
    )
    .run(patch.title?.trim() || current.title, html, text, id);
}

export function deleteDraft(id: number): void {
  db().prepare("DELETE FROM drafts WHERE id=?").run(id);
}

export function notesFor(draftId: number): DraftNote[] {
  return db()
    .prepare("SELECT * FROM draft_notes WHERE draft_id=? ORDER BY seq, id")
    .all(draftId) as DraftNote[];
}

export function addNote(
  draftId: number,
  note: Omit<Partial<DraftNote>, "id" | "draft_id"> & { text: string }
): DraftNote[] {
  const next =
    ((
      db()
        .prepare("SELECT COALESCE(MAX(seq), -1) AS m FROM draft_notes WHERE draft_id=?")
        .get(draftId) as { m: number }
    ).m ?? -1) + 1;

  db()
    .prepare(
      `INSERT INTO draft_notes
         (draft_id, kind, text, citation, note, entity_id, mention_id, chunk_id, source_id, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      draftId,
      note.kind ?? "quote",
      note.text,
      note.citation ?? null,
      note.note ?? null,
      note.entity_id ?? null,
      note.mention_id ?? null,
      note.chunk_id ?? null,
      note.source_id ?? null,
      next
    );

  return notesFor(draftId);
}

export function removeNote(draftId: number, noteId: number): DraftNote[] {
  db().prepare("DELETE FROM draft_notes WHERE id=? AND draft_id=?").run(noteId, draftId);
  return notesFor(draftId);
}

/** Reorders the shelf of gathered material to the given id order. */
export function reorderNotes(draftId: number, ids: number[]): DraftNote[] {
  const stmt = db().prepare("UPDATE draft_notes SET seq=? WHERE id=? AND draft_id=?");
  ids.forEach((id, i) => stmt.run(i, id, draftId));
  return notesFor(draftId);
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

export interface DraftCitation {
  id: number;
  draft_id: number;
  origin: "library" | "outside";
  text: string;
  author: string | null;
  title: string | null;
  year: string | null;
  locator: string | null;
  url: string | null;
  quote: string | null;
  source_id: number | null;
  mention_id: number | null;
  seq: number;
  created_at: string;
}

export function citationsFor(draftId: number): DraftCitation[] {
  return db()
    .prepare("SELECT * FROM draft_citations WHERE draft_id=? ORDER BY seq, id")
    .all(draftId) as DraftCitation[];
}

/**
 * Renders a reference the way a footnote reads.
 *
 * Author, title, year, locator — the order every note style agrees on, whatever
 * they do with the punctuation. Deliberately not a full citation-style engine:
 * choosing between Chicago and MLA is a decision for whoever you are submitting
 * to, and getting it half-right would be worse than leaving it plainly readable.
 */
export function renderCitation(c: {
  author?: string | null;
  title?: string | null;
  year?: string | null;
  locator?: string | null;
  url?: string | null;
}): string {
  const parts = [c.author?.trim(), c.title?.trim(), c.year?.trim(), c.locator?.trim()]
    .filter(Boolean)
    .join(", ");
  const url = c.url?.trim();
  return url ? `${parts}${parts ? ". " : ""}${url}` : parts;
}

export function addCitation(
  draftId: number,
  c: Partial<DraftCitation> & { origin?: "library" | "outside" }
): DraftCitation[] {
  const next =
    ((
      db()
        .prepare("SELECT COALESCE(MAX(seq), -1) AS m FROM draft_citations WHERE draft_id=?")
        .get(draftId) as { m: number }
    ).m ?? -1) + 1;

  const text = c.text?.trim() || renderCitation(c);
  if (!text) return citationsFor(draftId);

  db()
    .prepare(
      `INSERT INTO draft_citations
         (draft_id, origin, text, author, title, year, locator, url, quote, source_id, mention_id, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      draftId,
      c.origin ?? "library",
      text,
      c.author ?? null,
      c.title ?? null,
      c.year ?? null,
      c.locator ?? null,
      c.url ?? null,
      c.quote ?? null,
      c.source_id ?? null,
      c.mention_id ?? null,
      next
    );

  return citationsFor(draftId);
}

export function updateCitation(
  draftId: number,
  id: number,
  patch: Partial<DraftCitation>
): DraftCitation[] {
  const current = db()
    .prepare("SELECT * FROM draft_citations WHERE id=? AND draft_id=?")
    .get(id, draftId) as DraftCitation | undefined;
  if (!current) return citationsFor(draftId);

  const merged = { ...current, ...patch };
  const text = patch.text?.trim() || renderCitation(merged);

  db()
    .prepare(
      `UPDATE draft_citations
          SET text=?, author=?, title=?, year=?, locator=?, url=?
        WHERE id=? AND draft_id=?`
    )
    .run(
      text || current.text,
      merged.author ?? null,
      merged.title ?? null,
      merged.year ?? null,
      merged.locator ?? null,
      merged.url ?? null,
      id,
      draftId
    );

  return citationsFor(draftId);
}

export function removeCitation(draftId: number, id: number): DraftCitation[] {
  db().prepare("DELETE FROM draft_citations WHERE id=? AND draft_id=?").run(id, draftId);
  return citationsFor(draftId);
}
