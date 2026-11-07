import { db } from "./db";
import { htmlToText } from "./richtext";
import { formatCitation } from "./citation";
import { formatLocator } from "./chunk";
import { normalizeMarkers, retargetMarkers, stripMarkers } from "./cite-markers";
import type { Locator } from "./types";

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
  const row = db().prepare("SELECT * FROM drafts WHERE id=?").get(id) as Draft | undefined;
  if (!row) return undefined;
  // Belt and braces: rows written before the sanitiser existed, or by a hand
  // on the database, are cleaned on the way out as well as on the way in.
  return { ...row, body_html: sanitizeHtml(row.body_html ?? "") };
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

  // Reduced to the allowed markup before anything else reads it, so the
  // plain-text form below and the row itself both come from the clean copy;
  // and every citation marker numbered against the references as they stand
  // here, whatever the page that sent it believed.
  const html =
    refuse || patch.body_html === undefined
      ? current.body_html
      : normalizeMarkers(sanitizeHtml(patch.body_html), citationsFor(id));

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
  // Its web check has no foreign key to go with it.
  db().prepare("DELETE FROM text_web_checks WHERE target='draft' AND target_id=?").run(id);
}

/**
 * The citation a passage from the library carries when nothing supplied one:
 * the source's author, title and year, and the place in it, rendered the way
 * the desk's own search renders a hit — so a passage sent from the reader and
 * a quote found from the desk read the same at the foot of the page.
 */
export function citationForSource(sourceId: number, chunkId?: number | null): string | null {
  const s = db()
    .prepare("SELECT title, author, year, outlet FROM sources WHERE id=?")
    .get(sourceId) as
    | { title: string; author: string | null; year: string | null; outlet: string | null }
    | undefined;
  if (!s) return null;
  let locator = "";
  if (chunkId) {
    const c = db()
      .prepare(
        `SELECT c.locator_json, d.label AS doc_label FROM chunks c
      LEFT JOIN documents d ON d.id = c.doc_id WHERE c.id=? AND c.source_id=?`
      )
      .get(chunkId, sourceId) as { locator_json: string; doc_label: string | null } | undefined;
    if (c) {
      try {
        locator = formatLocator(JSON.parse(c.locator_json) as Locator, c.doc_label);
      } catch {
        locator = "";
      }
    }
  }
  return formatCitation({ author: s.author, title: s.title, year: s.year, outlet: s.outlet, locator });
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
// Sanitising
// ---------------------------------------------------------------------------

/**
 * The markup a draft may contain, and nothing else.
 *
 * The editor stores HTML and renders it back with innerHTML, which means a
 * draft body is code that runs in your browser. Anything that can reach
 * PUT /api/drafts — a phone on the same network, in LAN mode — could plant an
 * `<img onerror>` that, the next time you opened the desk, called every route
 * as you. So the body is reduced to this list on the way in, and again on the
 * way out for rows written before the list existed.
 *
 * The list is what the editor itself produces plus what the Word export
 * understands (lib/richtext.ts). A tag not on it is removed and its text kept;
 * a handful whose *contents* are not prose — script, style, iframe — lose the
 * contents too. `b` and `i`, which contenteditable emits for bold and italic,
 * are folded into `strong` and `em` so there is one spelling of each.
 *
 * Attributes are not filtered but rebuilt: the only ones that survive are
 * `href` on a link, and only when it is http or https, and on a citation
 * marker its `data-cite` and `data-note` numbers and `contenteditable="false"`
 * (lib/cite-markers.ts). Every event handler, style, class, id and src goes,
 * whatever it was called.
 *
 * Written against the same tokeniser idea as lib/richtext.ts rather than a
 * DOM library: this runs on the server, the input is small, and a parser we
 * can read end to end is the point of the exercise.
 */
const ALLOWED = new Set([
  "p", "h1", "h2", "h3", "h4", "ul", "ol", "li", "blockquote",
  "strong", "em", "u", "s", "a", "span", "br", "hr", "code", "pre",
]);
/**
 * Spellings folded into one.
 *
 * `b` and `i` are what contenteditable emits for bold and italic. `div` is the
 * important one: pressing Enter in a contenteditable region produces a `div`
 * per paragraph in Chrome and every browser built on it, and a sanitiser that
 * merely refuses an unknown tag keeps its text — so every paragraph in the
 * draft was being welded into one run of prose on save, and you saw it the
 * next time the draft loaded. A div around prose is a paragraph; it is now
 * read as one rather than thrown away.
 */
const RENAMED: Record<string, string> = { b: "strong", i: "em", strike: "s", del: "s", div: "p" };
/** Tags whose inner text is not prose and must go with them. */
const DROP_CONTENTS = new Set([
  "script", "style", "iframe", "object", "embed", "template", "noscript",
  "svg", "math", "textarea", "select", "head", "title",
]);
const VOID = new Set(["br", "hr"]);
/**
 * Blocks, and what they close on the way in.
 *
 * HTML does not allow a paragraph inside a paragraph, so a browser reading
 * `<p>one<p>two` sees two siblings — while a sanitiser that only tracks its
 * own stack would emit `<p>one<p>two</p></p>` and change the document's shape
 * on the way through. An open `p` yields to any block; an open `li` yields to
 * the next `li`.
 */
const BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "pre", "hr"]);

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g;

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sanitizeHtml(html: string): string {
  // Comments and anything else that opens with "<!" or "<?" are not markup
  // the editor makes; drop them whole rather than let a stray "<!--" swallow
  // the rest of the document in a browser's eyes.
  const input = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[!?][^>]*>/g, "");

  let out = "";
  let last = 0;
  /** Depth inside a tag whose contents are being dropped. */
  let dropping: string | null = null;
  let dropDepth = 0;
  /** Open allowed tags, so a stray closer cannot be emitted unmatched. */
  const open: string[] = [];

  const text = (raw: string) => {
    if (dropping) return;
    // A "<" that did not form a tag is text, and stays text.
    out += raw.replace(/</g, "&lt;");
  };

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(input))) {
    if (m.index > last) text(input.slice(last, m.index));
    last = m.index + m[0].length;

    const closing = m[1] === "/";
    const raw = m[2].toLowerCase();
    const attrs = m[3] ?? "";

    if (dropping) {
      if (raw === dropping) {
        if (closing) {
          dropDepth--;
          if (dropDepth === 0) dropping = null;
        } else if (m[4] !== "/") {
          dropDepth++;
        }
      }
      continue;
    }

    if (DROP_CONTENTS.has(raw)) {
      if (!closing && m[4] !== "/") {
        dropping = raw;
        dropDepth = 1;
      }
      continue;
    }

    const tag = RENAMED[raw] ?? raw;
    if (!ALLOWED.has(tag)) continue;

    // A block opening implicitly closes a paragraph, and a list item closes
    // the item before it — the same reading a browser gives the markup.
    if (!closing && BLOCKS.has(tag)) {
      while (open.length && (open[open.length - 1] === "p" || (tag === "li" && open[open.length - 1] === "li"))) {
        out += `</${open.pop()}>`;
      }
    }

    if (VOID.has(tag)) {
      if (!closing) out += `<${tag}>`;
      continue;
    }

    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at === -1) continue;
      // Close whatever was left open inside it, innermost first, so the
      // output nests properly whatever the input did.
      while (open.length > at) out += `</${open.pop()}>`;
      continue;
    }

    let rebuilt = "";
    if (tag === "a") {
      const href = attr(attrs, "href");
      const clean = href ? decodeEntities(href).trim() : "";
      // Only a web address. "javascript:" is the obvious one, but "data:" and
      // a bare "vbscript:" are the same hole; anything else becomes plain text
      // with the link removed rather than a link to somewhere we cannot vouch for.
      if (!/^https?:\/\/[^\s]+$/i.test(clean)) continue;
      rebuilt = ` href="${escapeAttr(clean)}" rel="noopener noreferrer"`;
    } else if (tag === "span") {
      const note = attr(attrs, "data-note")?.trim();
      const cite = attr(attrs, "data-cite")?.trim();
      const hasCite = !!cite && /^\d{1,12}$/.test(cite);
      const hasNote = !!note && /^\d{1,6}$/.test(note);
      // A span exists here for one reason: to carry a citation marker. The id
      // is what it points at; the index is only for older copies of Raazi.
      if (!hasCite && !hasNote) continue;
      if (hasCite) rebuilt = ` data-cite="${cite}"`;
      if (hasNote) rebuilt += ` data-note="${note}"`;
      // Kept uneditable through the save. Stripping this made every reopened
      // marker a span you could type into, and the export drops whatever is
      // inside a marker, so the words typed there vanished from the Word file.
      rebuilt += ` contenteditable="false"`;
    }

    out += `<${tag}${rebuilt}>`;
    open.push(tag);
  }
  if (last < input.length) text(input.slice(last));
  while (open.length) out += `</${open.pop()}>`;
  return out;
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
  outlet: string | null;
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

interface SourceRow {
  title: string;
  author: string | null;
  year: string | null;
  outlet: string | null;
  url: string | null;
}

function sourceRow(id: number | null | undefined): SourceRow | undefined {
  if (!id) return undefined;
  // An article often has a publication date and no year of its own; a
  // reference with no date at all reads as undated when it is not.
  return db()
    .prepare(
      `SELECT title, author, outlet, url,
              COALESCE(NULLIF(TRIM(year), ''), substr(published_at, 1, 4)) AS year
         FROM sources WHERE id=?`
    )
    .get(id) as SourceRow | undefined;
}

/**
 * The heading a chunker gives the whole of an article. It names no place in
 * the source, so as a locator it only made a footnote read "…, 2026, Text"
 * and made a second citation of the same article look like a different one.
 */
const NOT_A_PLACE = /^(text|body|article|content|main|full text|untitled)$/i;

function place(locator: string | null | undefined): string | null {
  const l = locator?.trim();
  return l && !NOT_A_PLACE.test(l) ? l : null;
}

/** Where a passage sits, from its chunk: a page, a timecode or a chapter. */
function placeOfChunk(chunkId: number | null | undefined, sourceId: number | null | undefined): string | null {
  if (!chunkId || !sourceId) return null;
  const c = db()
    .prepare("SELECT locator_json FROM chunks WHERE id=? AND source_id=?")
    .get(chunkId, sourceId) as { locator_json: string } | undefined;
  if (!c) return null;
  try {
    return formatLocator(JSON.parse(c.locator_json) as Locator) || null;
  } catch {
    return null;
  }
}

const squash = (s: string | null | undefined) =>
  (s ?? "").normalize("NFKC").toLowerCase().replace(/[\s.,;:]+/g, " ").trim();
const bareUrl = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\/+$/, "");

/**
 * Whether two references are the same reference.
 *
 * The same source at the same place is one reference however it was reached:
 * the shelf, the library search and the reader's Send to Write each used to
 * add a row of their own, so a source cited three ways sat in the list three
 * times under three numbers. Different pages of one book are different
 * references, as a footnote style would have them.
 */
export function sameReference(
  a: Pick<DraftCitation, "source_id" | "url" | "locator" | "text">,
  b: Pick<DraftCitation, "source_id" | "url" | "locator" | "text">
): boolean {
  const samePlace = squash(place(a.locator)) === squash(place(b.locator));
  if (a.source_id && b.source_id) return a.source_id === b.source_id && samePlace;
  if (a.url && b.url) return bareUrl(a.url) === bareUrl(b.url) && samePlace;
  if (a.source_id || b.source_id || a.url || b.url) return false;
  return squash(a.text) !== "" && squash(a.text) === squash(b.text);
}

/** The reference's fields, completed from its source, and the line it reads as. */
function completeReference(
  c: Partial<DraftCitation> & { chunk_id?: number | null },
  s: SourceRow | undefined
) {
  // A citation of something in the library is completed from the source
  // itself, whatever the caller happened to pass.
  //
  // There are four buttons that cite — the library search (a source and a
  // passage), the shelf beside the draft, and a mention in the reader — and
  // each used to send a different subset of the fields. The shelf sent only
  // the rendered text and a source id, so every reference made from it landed
  // with author, title, year and outlet all null. Filling the gaps from
  // `source_id` here means one rule instead of four, and a reference that
  // knows what it refers to.
  const author = c.author?.trim() || s?.author?.trim() || null;
  const title = c.title?.trim() || s?.title?.trim() || null;
  const year = c.year?.trim() || s?.year?.trim() || null;
  const outlet = c.outlet?.trim() || s?.outlet?.trim() || null;
  const locator = place(c.locator) ?? placeOfChunk(c.chunk_id, c.source_id);

  // The source's own address, so the exported footnote becomes a link a reader
  // can follow — which for an article is the whole difference between a
  // citation and a claim.
  let url = c.url?.trim() || null;
  if (!url && s?.url && /^https?:\/\//i.test(s.url)) url = s.url;

  // A reference to the library is always rendered from its parts. The line
  // the page sent was whatever that button had on screen — with a section
  // heading as the place, or the outlet repeated — and it went into the
  // footnote as sent. Only a reference with no source behind it keeps the
  // words it was given.
  const rendered = title
    ? formatCitation({ author, title, year, outlet, locator })
    : renderCitation({ author, year, locator, url });
  const text = (s ? rendered : c.text?.trim() || rendered) || c.text?.trim() || "";
  return { author, title, year, outlet, locator, url, text };
}

/**
 * Cites a reference in a draft: the one already in its list when it is the
 * same reference, a new one otherwise. Returns the id to put in the marker.
 */
export function citeReference(
  draftId: number,
  c: Partial<DraftCitation> & { origin?: "library" | "outside"; chunk_id?: number | null }
): { id: number | null; citations: DraftCitation[] } {
  const s = sourceRow(c.source_id);
  const ref = completeReference(c, s);
  if (!ref.text) return { id: null, citations: citationsFor(draftId) };

  const existing = citationsFor(draftId).find((r) =>
    sameReference(r, { source_id: c.source_id ?? null, url: ref.url, locator: ref.locator, text: ref.text })
  );
  if (existing) return { id: existing.id, citations: citationsFor(draftId) };

  const next =
    ((
      db()
        .prepare("SELECT COALESCE(MAX(seq), -1) AS m FROM draft_citations WHERE draft_id=?")
        .get(draftId) as { m: number }
    ).m ?? -1) + 1;

  const id = Number(
    db()
      .prepare(
        `INSERT INTO draft_citations
           (draft_id, origin, text, author, title, year, locator, outlet, url, quote, source_id, mention_id, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        draftId,
        c.origin ?? "library",
        ref.text,
        ref.author,
        ref.title,
        ref.year,
        ref.locator,
        ref.outlet,
        ref.url,
        c.quote ?? null,
        c.source_id ?? null,
        c.mention_id ?? null,
        next
      ).lastInsertRowid
  );

  return { id, citations: citationsFor(draftId) };
}

/** Adds a reference (or finds the one already there) and returns the list. */
export function addCitation(
  draftId: number,
  c: Partial<DraftCitation> & { origin?: "library" | "outside"; chunk_id?: number | null }
): DraftCitation[] {
  return citeReference(draftId, c).citations;
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
  // The same rule addCitation uses. These two disagreed: adding a reference
  // rendered "Author, Title, Year", editing one rendered the same with the
  // address appended to the end of the sentence, so correcting a typo in a
  // title silently changed the shape of the reference.
  const text =
    patch.text?.trim() ||
    (merged.title
      ? formatCitation({
          author: merged.author,
          title: merged.title,
          year: merged.year,
          outlet: merged.outlet,
          locator: merged.locator,
        })
      : renderCitation(merged));

  db()
    .prepare(
      `UPDATE draft_citations
          SET text=?, author=?, title=?, year=?, locator=?, outlet=?, url=?
        WHERE id=? AND draft_id=?`
    )
    .run(
      text || current.text,
      merged.author ?? null,
      merged.title ?? null,
      merged.year ?? null,
      merged.locator ?? null,
      merged.outlet ?? null,
      merged.url ?? null,
      id,
      draftId
    );

  return citationsFor(draftId);
}

/**
 * Removes a reference, and its markers with it.
 *
 * The page takes them out of the text it is showing too; doing it here as
 * well means a draft is never left citing a reference that is not there,
 * whatever happens to the page's next save.
 */
export function removeCitation(draftId: number, id: number): DraftCitation[] {
  const tx = db().transaction(() => {
    db().prepare("DELETE FROM draft_citations WHERE id=? AND draft_id=?").run(id, draftId);
    const row = db().prepare("SELECT body_html FROM drafts WHERE id=?").get(draftId) as
      | { body_html: string | null }
      | undefined;
    if (!row?.body_html) return;
    const html = normalizeMarkers(stripMarkers(row.body_html, id), citationsFor(draftId));
    if (html !== row.body_html) {
      db().prepare("UPDATE drafts SET body_html=?, body_md=? WHERE id=?").run(html, htmlToText(html), draftId);
    }
  });
  tx();
  return citationsFor(draftId);
}

/**
 * Brings a draft's references and markers up to the current rules.
 *
 * - A marker from before ids were recorded gets the id at its index — what
 *   the desk has always shown for it — so nothing later can shift it.
 * - A reference to the library is re-rendered from its parts, filling any
 *   the source can supply; one typed by hand keeps its words.
 * - The same reference listed twice becomes one: every marker for the later
 *   copy points at the earlier, and the later copy goes.
 * - Every marker is numbered by first appearance.
 *
 * Idempotent, and it changes what a draft *cites* never; only how. Run when a
 * draft is opened, so drafts written under the old rules — or pulled from a
 * laptop still running them — are put right before you see them. Does not
 * touch `updated_at`: a repair is not an edit.
 */
export function repairCitations(draftId: number): boolean {
  let changed = false;
  const tx = db().transaction(() => {
    const row = db().prepare("SELECT body_html FROM drafts WHERE id=?").get(draftId) as
      | { body_html: string | null }
      | undefined;
    if (!row) return;
    const before = row.body_html ?? "";
    // Legacy markers first, against the list exactly as it is stored.
    let html = normalizeMarkers(before, citationsFor(draftId));

    const kept: DraftCitation[] = [];
    for (const r of citationsFor(draftId)) {
      const twin = kept.find((k) => sameReference(k, r));
      if (twin) {
        html = retargetMarkers(html, r.id, twin.id);
        db().prepare("DELETE FROM draft_citations WHERE id=?").run(r.id);
        changed = true;
        continue;
      }
      kept.push(r);
      if (r.origin !== "library" || !r.source_id) continue;
      const s = sourceRow(r.source_id);
      if (!s) continue;
      const ref = completeReference({ ...r, text: undefined }, s);
      if (
        ref.text !== r.text ||
        ref.locator !== r.locator ||
        ref.year !== r.year ||
        ref.url !== r.url ||
        ref.author !== r.author ||
        ref.title !== r.title ||
        ref.outlet !== r.outlet
      ) {
        db()
          .prepare(
            "UPDATE draft_citations SET text=?, author=?, title=?, year=?, locator=?, outlet=?, url=? WHERE id=?"
          )
          .run(ref.text, ref.author, ref.title, ref.year, ref.locator, ref.outlet, ref.url, r.id);
        changed = true;
      }
    }

    html = normalizeMarkers(html, citationsFor(draftId));
    if (html !== before) {
      db().prepare("UPDATE drafts SET body_html=?, body_md=? WHERE id=?").run(html, htmlToText(html), draftId);
      changed = true;
    }
  });
  tx();
  return changed;
}
