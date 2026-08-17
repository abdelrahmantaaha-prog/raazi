import { db, tx } from "./db";
import {
  isReason,
  quoteKeyOf,
  reasonSpec,
  type DiscardReason,
  type DiscardScope,
} from "./discard-reasons";

/**
 * Auditing an entry by hand.
 *
 * Everything else in Corpus decides what counts as evidence by asking a model.
 * This is the one place where you overrule it, and the design follows from what
 * makes that worth doing at all: a rejection you have to repeat is not a
 * judgement, it is a chore. So a discard does two separate things, and it is
 * worth being exact about which is which, because only one of them is a
 * guarantee.
 *
 * 1. It BLOCKS. The quote never returns to that subject's evidence — not when
 *    the source is re-extracted, not when Enhance takes a second look, not when
 *    the zero-token sweep matches the name again. This is a deterministic rule
 *    enforced in SQL and in the two places mentions are written. It holds
 *    whatever any model decides later.
 *
 * 2. It TEACHES. Your reason is carried back into the prompts that produced the
 *    mistake — the entry writer for that subject, the extractor for that source
 *    — as a standing correction in your own words. This is a nudge, not a
 *    guarantee: a model told "you have twice attributed the son's quotes to the
 *    father here" will usually not do it a third time, and may. The value is
 *    real and the mechanism is suggestion.
 *
 * Stating that split plainly matters more than it might seem. "Corpus learns
 * from your corrections" is the kind of claim that quietly means nothing; what
 * is true here is that the same passage cannot come back, and that the model is
 * told why it was wrong.
 *
 * Nothing is deleted. A discarded mention keeps its row and stays readable under
 * the entry, marked with your reason, and can be restored — because the only
 * thing worse than evidence you have to reject by hand is evidence that
 * disappears when you do.
 */

export type { DiscardReason, DiscardScope, ReasonSpec } from "./discard-reasons";
export { DISCARD_REASONS, quoteKeyOf, reasonLabel, reasonSpec } from "./discard-reasons";

export interface DiscardRow {
  id: number;
  entity_id: number | null;
  entity_norm: string;
  entity_name: string;
  entity_type: string;
  quote: string;
  quote_key: string;
  surface: string | null;
  source_id: number | null;
  chunk_id: number | null;
  reason: DiscardReason;
  note: string | null;
  scope: DiscardScope;
  created_at: string;
  /** Joined for display; absent on the raw row. */
  source_title?: string | null;
}

/**
 * Throws one passage out of one entry.
 *
 * The mention is marked rather than deleted, and the verdict is written to the
 * durable ledger in the same transaction — the two must not be able to disagree.
 */
export function discardEvidence(args: {
  mentionId: number;
  reason: DiscardReason;
  note?: string | null;
  scope?: DiscardScope;
}): { ok: true; entityId: number; discardId: number } | { ok: false; error: string } {
  const row = db()
    .prepare(
      `SELECT m.id, m.entity_id, m.quote, m.surface, m.source_id, m.chunk_id, m.discarded_at,
              e.normalized AS entity_norm, e.canonical_name AS entity_name, e.type AS entity_type
         FROM mentions m
         JOIN entities e ON e.id = m.entity_id
        WHERE m.id = ?`
    )
    .get(args.mentionId) as
    | {
        id: number;
        entity_id: number;
        quote: string;
        surface: string | null;
        source_id: number;
        chunk_id: number;
        discarded_at: string | null;
        entity_norm: string;
        entity_name: string;
        entity_type: string;
      }
    | undefined;

  if (!row) return { ok: false, error: "That passage is no longer here." };
  if (!isReason(args.reason)) return { ok: false, error: "Unknown reason." };

  const scope: DiscardScope = args.scope === "library" ? "library" : "entity";
  const note = args.note?.trim() || null;
  let discardId = 0;

  tx(() => {
    db()
      .prepare("UPDATE mentions SET discarded_at=datetime('now'), discard_reason=? WHERE id=?")
      .run(args.reason, row.id);

    // ON CONFLICT rather than INSERT OR IGNORE: discarding the same quote again
    // with a better reason should replace the verdict, not silently keep the
    // first one.
    discardId = Number(
      db()
        .prepare(
          `INSERT INTO evidence_discards
             (entity_id, entity_norm, entity_name, entity_type, quote, quote_key,
              surface, source_id, chunk_id, reason, note, scope)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(entity_norm, quote_key) DO UPDATE SET
             reason=excluded.reason, note=excluded.note, scope=excluded.scope,
             entity_id=excluded.entity_id, created_at=datetime('now')`
        )
        .run(
          row.entity_id,
          row.entity_norm,
          row.entity_name,
          row.entity_type,
          row.quote,
          quoteKeyOf(row.quote),
          row.surface,
          row.source_id,
          row.chunk_id,
          args.reason,
          note,
          scope
        ).lastInsertRowid
    );

    // The entry still cites what you just rejected, so it no longer reflects
    // the record. Whether it is rewritten now is the caller's decision.
    db()
      .prepare("UPDATE entities SET entry_state='stale' WHERE id=? AND entry_state='fresh'")
      .run(row.entity_id);
  });

  return { ok: true, entityId: row.entity_id, discardId };
}

/** Puts a passage back, and forgets the verdict that kept it out. */
export function restoreEvidence(mentionId: number): { ok: boolean; entityId?: number } {
  const row = db()
    .prepare(
      `SELECT m.id, m.entity_id, m.quote, e.normalized AS entity_norm
         FROM mentions m JOIN entities e ON e.id = m.entity_id
        WHERE m.id = ?`
    )
    .get(mentionId) as
    | { id: number; entity_id: number; quote: string; entity_norm: string }
    | undefined;
  if (!row) return { ok: false };

  tx(() => {
    db()
      .prepare("UPDATE mentions SET discarded_at=NULL, discard_reason=NULL WHERE id=?")
      .run(row.id);
    db()
      .prepare("DELETE FROM evidence_discards WHERE entity_norm=? AND quote_key=?")
      .run(row.entity_norm, quoteKeyOf(row.quote));
    db()
      .prepare("UPDATE entities SET entry_state='stale' WHERE id=? AND entry_state='fresh'")
      .run(row.entity_id);
  });

  return { ok: true, entityId: row.entity_id };
}

/** The verdicts standing against one subject, newest first. */
export function discardsFor(entityId: number): DiscardRow[] {
  return db()
    .prepare(
      `SELECT d.*, s.title AS source_title
         FROM evidence_discards d
    LEFT JOIN sources s ON s.id = d.source_id
        WHERE d.entity_id = ?
           OR d.entity_norm = (SELECT normalized FROM entities WHERE id = ?)
        ORDER BY d.created_at DESC, d.id DESC`
    )
    .all(entityId, entityId) as DiscardRow[];
}

/** Standing corrections that apply everywhere, newest first. */
export function libraryCorrections(): DiscardRow[] {
  return db()
    .prepare(
      `SELECT d.*, s.title AS source_title
         FROM evidence_discards d
    LEFT JOIN sources s ON s.id = d.source_id
        WHERE d.scope = 'library'
        ORDER BY d.created_at DESC, d.id DESC`
    )
    .all() as DiscardRow[];
}

/** Drops a verdict outright, whether or not its mention still exists. */
export function forgetDiscard(discardId: number): boolean {
  const row = db()
    .prepare("SELECT entity_norm, quote_key FROM evidence_discards WHERE id=?")
    .get(discardId) as { entity_norm: string; quote_key: string } | undefined;
  if (!row) return false;

  tx(() => {
    // Un-mark exactly the passages this verdict is suppressing — matched the
    // same way it was recorded, and no others. Comparing in SQL would have to
    // be `lower(trim(quote))`, which does not collapse the internal whitespace
    // that quoteKeyOf does, so a quote wrapped across two lines would not match
    // itself.
    for (const m of db()
      .prepare(
        `SELECT m.id, m.quote FROM mentions m
           JOIN entities e ON e.id = m.entity_id
          WHERE e.normalized = ? AND m.discarded_at IS NOT NULL`
      )
      .all(row.entity_norm) as { id: number; quote: string }[]) {
      if (quoteKeyOf(m.quote) !== row.quote_key) continue;
      db()
        .prepare("UPDATE mentions SET discarded_at=NULL, discard_reason=NULL WHERE id=?")
        .run(m.id);
    }
    db().prepare("DELETE FROM evidence_discards WHERE id=?").run(discardId);
  });
  return true;
}

/**
 * Is this quote already rejected for this subject?
 *
 * Called on the insert path for every candidate mention, so it reads from a set
 * built once per pass rather than querying per row.
 */
export function discardIndex(): Set<string> {
  const rows = db()
    .prepare("SELECT entity_norm, quote_key FROM evidence_discards")
    .all() as { entity_norm: string; quote_key: string }[];
  return new Set(rows.map((r) => `${r.entity_norm}${r.quote_key}`));
}

export function isDiscarded(index: Set<string>, entityNorm: string, quote: string): boolean {
  return index.has(`${entityNorm}${quoteKeyOf(quote)}`);
}

/**
 * Re-applies the ledger to whatever is currently in the mentions table.
 *
 * Re-extraction writes new rows for old quotes, and those rows arrive without
 * the marks their predecessors carried. Running this afterwards is what makes
 * the block survive — the insert-time check catches the common path, and this
 * catches everything, including material written before the check existed.
 */
export function reapplyDiscards(sourceId?: number): number {
  const verdicts = new Map<string, DiscardReason>();
  for (const d of db()
    .prepare("SELECT entity_norm, quote_key, reason FROM evidence_discards")
    .all() as { entity_norm: string; quote_key: string; reason: DiscardReason }[]) {
    verdicts.set(`${d.entity_norm}${d.quote_key}`, d.reason);
  }
  if (verdicts.size === 0) return 0;

  // Matched in JS rather than in SQL, so the comparison is the same function
  // that recorded the verdict. SQLite's lower(trim(...)) leaves the internal
  // whitespace alone, and a quote re-extracted with its line breaks folded
  // differently would silently fail to match itself — which is precisely the
  // case this exists to catch.
  const rows = db()
    .prepare(
      `SELECT m.id, m.quote, e.normalized AS entity_norm
         FROM mentions m JOIN entities e ON e.id = m.entity_id
        WHERE m.discarded_at IS NULL ${sourceId ? "AND m.source_id = ?" : ""}`
    )
    .all(...(sourceId ? [sourceId] : [])) as {
    id: number;
    quote: string;
    entity_norm: string;
  }[];

  let stamped = 0;
  tx(() => {
    const mark = db().prepare(
      "UPDATE mentions SET discarded_at=datetime('now'), discard_reason=? WHERE id=?"
    );
    for (const m of rows) {
      const reason = verdicts.get(`${m.entity_norm}${quoteKeyOf(m.quote)}`);
      if (!reason) continue;
      mark.run(reason, m.id);
      stamped++;
    }
  });
  return stamped;
}

/** How many verdicts are standing, for the places that report on themselves. */
export function discardCount(entityId?: number): number {
  const row = entityId
    ? (db()
        .prepare(
          `SELECT COUNT(*) AS n FROM evidence_discards
            WHERE entity_id=? OR entity_norm=(SELECT normalized FROM entities WHERE id=?)`
        )
        .get(entityId, entityId) as { n: number })
    : (db().prepare("SELECT COUNT(*) AS n FROM evidence_discards").get() as { n: number });
  return row.n;
}

/* -------------------------------------------------------------------------- *
 * Teaching
 *
 * What the model is told, and how much of it. A correction is only useful while
 * it is specific enough to act on and short enough to be read, so each reason
 * appears once with a count and at most two examples in your own words. Twelve
 * of these would be a wall of text that shifts nothing; three are instructions.
 * -------------------------------------------------------------------------- */

const MAX_REASONS_SHOWN = 4;
const MAX_NOTES_PER_REASON = 2;

function render(rows: DiscardRow[], heading: string): string {
  if (rows.length === 0) return "";

  const byReason = new Map<DiscardReason, DiscardRow[]>();
  for (const r of rows) {
    if (!isReason(r.reason)) continue;
    const list = byReason.get(r.reason) ?? [];
    list.push(r);
    byReason.set(r.reason, list);
  }

  /**
   * A correction you deliberately marked as applying library-wide outranks one
   * raised in passing, however many times the second happened.
   *
   * Without this the cap silently defeats the feature: ticking "apply this
   * everywhere" writes a rule that then never reaches a prompt, because four
   * incidental rejections on some busy entry crowd it out. Frequency is the
   * right tie-break between accidents, not between an accident and a decision.
   */
  const ordered = [...byReason.entries()].sort((a, b) => {
    const standing = (list: DiscardRow[]) => (list.some((r) => r.scope === "library") ? 1 : 0);
    return standing(b[1]) - standing(a[1]) || b[1].length - a[1].length;
  });

  const lines: string[] = [];
  for (const [reason, list] of ordered.slice(0, MAX_REASONS_SHOWN)) {
    const spec = reasonSpec(reason)!;
    const times = list.length === 1 ? "once" : `${list.length} times`;
    lines.push(`- ${spec.teaches} (rejected ${times})`);
    // Your standing notes first, for the same reason.
    const notes = [...list].sort(
      (a, b) => (b.scope === "library" ? 1 : 0) - (a.scope === "library" ? 1 : 0)
    );
    for (const note of notes
      .map((r) => r.note?.trim())
      .filter((n): n is string => Boolean(n))
      .slice(0, MAX_NOTES_PER_REASON)) {
      lines.push(`  In their words: "${note}"`);
    }
  }

  return `${heading}\n${lines.join("\n")}`;
}

/**
 * What the entry writer is told before it writes about this subject.
 *
 * Both the subject's own verdicts and the library-wide ones, because a standing
 * correction that only applied to the entry it was written on would not be a
 * standing correction.
 */
export function correctionsFor(entityId: number): string {
  const rows = [
    ...discardsFor(entityId),
    ...libraryCorrections().filter((r) => r.entity_id !== entityId),
  ];
  return render(
    rows,
    `STANDING CORRECTIONS. The researcher has rejected evidence filed under this
subject before. These are their judgements, and they override your own reading:`
  );
}

/**
 * What the extractor is told before it reads a passage from this source.
 *
 * Scoped to corrections raised against this source, plus the library-wide ones.
 * Every correction in the database would be both enormous and mostly irrelevant
 * to the book in hand.
 */
export function correctionsForSource(sourceId: number): string {
  const rows = db()
    .prepare(
      `SELECT * FROM evidence_discards
        WHERE source_id = ? OR scope = 'library'
        ORDER BY created_at DESC`
    )
    .all(sourceId) as DiscardRow[];

  return render(
    rows,
    `STANDING CORRECTIONS. The researcher has rejected material extracted from
this source before, for these reasons. Do not repeat them:`
  );
}
