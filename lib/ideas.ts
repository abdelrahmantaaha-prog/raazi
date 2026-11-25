import { db, tx } from "./db";
import { createDraft } from "./drafts";
import { IDEA_STATES, MAX_OUTLINE_DEPTH, type IdeaState } from "./idea-states";

/**
 * The notebook that comes before the draft.
 *
 * Raazi could already hold everything except the part where you decide what to
 * write. Notes attach to a draft, so keeping one meant starting a draft; and a
 * draft you started because you had a thought at midnight is a draft that sits
 * at nought words reproaching you. An idea is allowed to be one sentence and to
 * stay that way for a year.
 *
 * Deliberately, and like the Writing desk it sits inside, nothing here calls a
 * model. Working out what you think is the part you asked to keep for yourself.
 */

export type { IdeaState } from "./idea-states";

export interface Idea {
  id: number;
  title: string;
  note: string;
  state: IdeaState;
  draft_id: number | null;
  seq: number;
  created_at: string;
  updated_at: string;
}

export interface OutlinePoint {
  id: number;
  idea_id: number;
  text: string;
  depth: number;
  seq: number;
  quote: string | null;
  citation: string | null;
  entity_id: number | null;
  source_id: number | null;
}

export interface IdeaSummary extends Idea {
  points: number;
  /** Points carrying a quote — how much of the outline is already evidenced. */
  evidenced: number;
  draft_title: string | null;
}

export function listIdeas(): IdeaSummary[] {
  return db()
    .prepare(
      `SELECT i.*,
              (SELECT COUNT(*) FROM outline_points p WHERE p.idea_id = i.id) AS points,
              (SELECT COUNT(*) FROM outline_points p
                WHERE p.idea_id = i.id AND p.quote IS NOT NULL AND p.quote <> '') AS evidenced,
              (SELECT d.title FROM drafts d WHERE d.id = i.draft_id) AS draft_title
         FROM ideas i
        ORDER BY
          -- Live work first, parked and finished last; then newest.
          CASE i.state WHEN 'developing' THEN 0 WHEN 'seed' THEN 1
                       WHEN 'drafted' THEN 2 ELSE 3 END,
          i.updated_at DESC`
    )
    .all() as IdeaSummary[];
}

export function getIdea(id: number): (Idea & { outline: OutlinePoint[] }) | undefined {
  const idea = db().prepare("SELECT * FROM ideas WHERE id=?").get(id) as Idea | undefined;
  if (!idea) return undefined;
  return { ...idea, outline: outlineFor(id) };
}

export function outlineFor(ideaId: number): OutlinePoint[] {
  return db()
    .prepare("SELECT * FROM outline_points WHERE idea_id=? ORDER BY seq, id")
    .all(ideaId) as OutlinePoint[];
}

/**
 * The point, if it belongs to this idea.
 *
 * The outline route names the idea in its URL and the point in its body, and
 * used to act on the point alone — so any idea's URL could edit or delete any
 * other idea's points. Every point operation goes through this first.
 */
export function pointOf(ideaId: number, pointId: number): OutlinePoint | undefined {
  return db()
    .prepare("SELECT * FROM outline_points WHERE id=? AND idea_id=?")
    .get(pointId, ideaId) as OutlinePoint | undefined;
}

export function isIdeaState(v: unknown): v is IdeaState {
  return IDEA_STATES.some((s) => s.id === v);
}

/** A depth the outline can hold, or undefined for anything else. */
export function asDepth(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_OUTLINE_DEPTH
    ? v
    : undefined;
}

export function createIdea(title = "", note = ""): number {
  return Number(
    db()
      .prepare("INSERT INTO ideas (title, note) VALUES (?, ?)")
      .run(title.trim() || "Untitled", note.trim()).lastInsertRowid
  );
}

export function updateIdea(
  id: number,
  patch: { title?: string; note?: string; state?: IdeaState }
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title=?");
    params.push(patch.title.trim() || "Untitled");
  }
  if (patch.note !== undefined) {
    sets.push("note=?");
    params.push(patch.note);
  }
  if (patch.state !== undefined) {
    sets.push("state=?");
    params.push(patch.state);
  }
  if (!sets.length) return;
  sets.push("updated_at=datetime('now')");
  db().prepare(`UPDATE ideas SET ${sets.join(", ")} WHERE id=?`).run(...params, id);
}

export function deleteIdea(id: number): void {
  db().prepare("DELETE FROM ideas WHERE id=?").run(id);
}

/** Adds a point at the end, at the depth of the one above it. */
export function addPoint(ideaId: number, text = "", depth?: number): number {
  const last = db()
    .prepare("SELECT depth, seq FROM outline_points WHERE idea_id=? ORDER BY seq DESC, id DESC LIMIT 1")
    .get(ideaId) as { depth: number; seq: number } | undefined;

  const id = Number(
    db()
      .prepare("INSERT INTO outline_points (idea_id, text, depth, seq) VALUES (?, ?, ?, ?)")
      .run(ideaId, text, depth ?? last?.depth ?? 0, (last?.seq ?? -1) + 1).lastInsertRowid
  );
  touch(ideaId);
  return id;
}

export function updatePoint(
  id: number,
  patch: { text?: string; depth?: number; quote?: string | null; citation?: string | null }
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.text !== undefined) {
    sets.push("text=?");
    params.push(patch.text);
  }
  if (patch.depth !== undefined) {
    // Two levels is the whole range; deeper outlines stop being readable.
    sets.push("depth=?");
    params.push(Math.max(0, Math.min(MAX_OUTLINE_DEPTH, patch.depth)));
  }
  if (patch.quote !== undefined) {
    sets.push("quote=?");
    params.push(patch.quote);
  }
  if (patch.citation !== undefined) {
    sets.push("citation=?");
    params.push(patch.citation);
  }
  if (!sets.length) return;
  db().prepare(`UPDATE outline_points SET ${sets.join(", ")} WHERE id=?`).run(...params, id);

  const row = db().prepare("SELECT idea_id FROM outline_points WHERE id=?").get(id) as
    | { idea_id: number }
    | undefined;
  if (row) touch(row.idea_id);
}

export function deletePoint(id: number): void {
  const row = db().prepare("SELECT idea_id FROM outline_points WHERE id=?").get(id) as
    | { idea_id: number }
    | undefined;
  db().prepare("DELETE FROM outline_points WHERE id=?").run(id);
  if (row) touch(row.idea_id);
}

/**
 * Moves a point up or down among its siblings.
 *
 * Swaps sequence numbers with the neighbour rather than renumbering the list,
 * which keeps it to two writes however long the outline is.
 */
export function movePoint(id: number, direction: -1 | 1): void {
  const row = db().prepare("SELECT * FROM outline_points WHERE id=?").get(id) as
    | OutlinePoint
    | undefined;
  if (!row) return;

  const neighbour = db()
    .prepare(
      direction < 0
        ? "SELECT * FROM outline_points WHERE idea_id=? AND seq < ? ORDER BY seq DESC LIMIT 1"
        : "SELECT * FROM outline_points WHERE idea_id=? AND seq > ? ORDER BY seq ASC LIMIT 1"
    )
    .get(row.idea_id, row.seq) as OutlinePoint | undefined;
  if (!neighbour) return;

  tx(() => {
    const swap = db().prepare("UPDATE outline_points SET seq=? WHERE id=?");
    swap.run(neighbour.seq, row.id);
    swap.run(row.seq, neighbour.id);
  });
  touch(row.idea_id);
}

/**
 * Turns an idea into a draft.
 *
 * The outline becomes the draft's skeleton — headings for the top level,
 * paragraphs for the points beneath, and any quote you gathered along the way
 * placed under the point it belongs to. It is a starting page, not a piece of
 * writing: nothing here composes prose, and the point of the Writing desk is
 * that nothing ever will.
 *
 * The idea is not consumed. It keeps a pointer to what it became, so the
 * thinking behind a finished piece stays findable.
 */
export function draftFromIdea(ideaId: number): number | null {
  const idea = getIdea(ideaId);
  if (!idea) return null;

  const html: string[] = [];
  if (idea.note.trim()) {
    html.push(`<blockquote>${escapeHtml(idea.note.trim())}</blockquote>`);
  }

  for (const p of idea.outline) {
    const text = p.text.trim();
    if (text) {
      if (p.depth === 0) html.push(`<h2>${escapeHtml(text)}</h2>`);
      else if (p.depth === 1) html.push(`<p>${escapeHtml(text)}</p>`);
      else html.push(`<p><em>${escapeHtml(text)}</em></p>`);
    }
    if (p.quote?.trim()) {
      const cite = p.citation?.trim();
      html.push(
        `<blockquote>${escapeHtml(p.quote.trim())}${cite ? ` — ${escapeHtml(cite)}` : ""}</blockquote>`
      );
    }
  }

  if (html.length === 0) html.push("<p></p>");

  const draftId = createDraft(idea.title);
  db()
    .prepare("UPDATE drafts SET body_html=?, body_md=?, updated_at=datetime('now') WHERE id=?")
    .run(html.join("\n"), plainText(html.join("\n")), draftId);

  db()
    .prepare("UPDATE ideas SET draft_id=?, state='drafted', updated_at=datetime('now') WHERE id=?")
    .run(draftId, ideaId);

  return draftId;
}

function touch(ideaId: number) {
  db().prepare("UPDATE ideas SET updated_at=datetime('now') WHERE id=?").run(ideaId);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function plainText(html: string): string {
  return html
    .replace(/<\/(p|h1|h2|h3|blockquote|li)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
