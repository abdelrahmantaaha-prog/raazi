import { db, tx } from "../db";
import { normalize } from "../normalize";
import { finishTask } from "../queue";
import { discardIndex, isDiscarded } from "../audit";
import { needsContext } from "../deixis";
import type { Task } from "../types";

/**
 * Finds the appearances extraction walked past.
 *
 * Measured on a 127-passage book: the entities it knows about were named in 802
 * passages and recorded in 300. Sixty-three per cent of appearances left no
 * trace, and the bias was systematic — the *commonest* subjects fared worst.
 * "United States" appeared in 121 passages and produced 24 mentions; a minor
 * figure named twice produced two. That is what a model does when asked to list
 * the entities in three thousand words: it returns the salient ones, and a name
 * that appears on every page stops being salient.
 *
 * No model can fix that, and none is used here. Once the library knows an
 * entity and the forms its sources use for it, finding the rest of its
 * appearances is string matching — exact, instant, and free. The quote is cut
 * from the passage itself, so it is verbatim by construction rather than by
 * inspection.
 *
 * What this deliberately does not do is invent entities. It only finds further
 * appearances of entities extraction has already identified, which is why it is
 * safe to run unattended: the judgement of "is this a thing worth recording"
 * was already made by something capable of making it.
 */

/** Below this a name matches too much: "Al", "UN", "PLO" inside other words. */
const MIN_ALIAS = 4;

/** One mention per passage per entity, as everywhere else in the pipeline. */
interface Candidate {
  entityId: number;
  surface: string;
  re: RegExp;
}

export async function handleSweep(task: Task): Promise<void> {
  const { sourceId } = JSON.parse(task.payload_json) as { sourceId: number };
  const found = sweepSource(sourceId);

  finishTask(
    task.id,
    task.run_id,
    { tokensIn: 0, tokensOut: 0 },
    "done",
    found === 0
      ? "No further appearances to record."
      : `Recorded ${found} further appearance(s) that extraction passed over.`
  );
}

export function sweepSource(sourceId: number): number {
  const chunks = db()
    .prepare(
      "SELECT id, text FROM chunks WHERE source_id=? AND extracted_at IS NOT NULL ORDER BY seq"
    )
    .all(sourceId) as { id: number; text: string }[];
  if (!chunks.length) return 0;

  const candidates = candidatesFor(sourceId);
  if (!candidates.length) return 0;

  // Which (entity, passage) pairs are already on record.
  const existing = new Set(
    (
      db()
        .prepare("SELECT entity_id, chunk_id FROM mentions WHERE source_id=?").all(sourceId) as {
        entity_id: number;
        chunk_id: number;
      }[]
    ).map((m) => `${m.entity_id}:${m.chunk_id}`)
  );

  const insert = db().prepare(
    `INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote, claim, context, confidence)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 0.8)`
  );
  const touched = new Set<number>();
  let added = 0;

  // Passages you have already thrown out. The sweep is the likeliest way for a
  // rejected quote to reappear — it matches on the name alone, which is exactly
  // the reasoning that produces a wrong attribution in the first place.
  const rejected = discardIndex();
  const normOf = new Map(
    (
      db().prepare("SELECT id, normalized FROM entities").all() as {
        id: number;
        normalized: string;
      }[]
    ).map((e) => [e.id, e.normalized])
  );
  let blocked = 0;

  tx(() => {
    for (const chunk of chunks) {
      for (const c of candidates) {
        if (existing.has(`${c.entityId}:${chunk.id}`)) continue;

        c.re.lastIndex = 0;
        const hit = c.re.exec(chunk.text);
        if (!hit) continue;

        const quote = sentenceAround(chunk.text, hit.index, hit[0].length);
        if (!quote) continue;

        const norm = normOf.get(c.entityId);
        if (norm && isDiscarded(rejected, norm, quote)) {
          blocked++;
          continue;
        }

        insert.run(c.entityId, chunk.id, sourceId, hit[0], quote);
        existing.add(`${c.entityId}:${chunk.id}`);
        touched.add(c.entityId);
        added++;
      }
    }

    // New evidence means the entries built without it are out of date.
    if (touched.size) {
      const stale = db().prepare(
        "UPDATE entities SET entry_state='stale' WHERE id=? AND entry_state='fresh'"
      );
      for (const id of touched) stale.run(id);
    }
  });

  if (blocked > 0) {
    console.log(`[corpus] sweep: held back ${blocked} passage(s) you had rejected`);
  }
  return added;
}

/**
 * The names worth looking for in this source.
 *
 * Only entities the source already mentions, so the scan stays small and the
 * question stays narrow — "where else does this book name Netanyahu" rather
 * than "does this book contain any of nine thousand entities".
 *
 * An alias shared by two entities is dropped outright. That is the same lesson
 * as the merge bug: a name that could mean either of two people identifies
 * neither, and a mention filed against a coin toss is worse than a mention
 * missed.
 */
function candidatesFor(sourceId: number): Candidate[] {
  const rows = db()
    .prepare(
      `SELECT DISTINCT a.entity_id, a.surface
         FROM mentions m
         JOIN aliases a ON a.entity_id = m.entity_id
         JOIN entities e ON e.id = a.entity_id
        WHERE m.source_id = ? AND e.merged_into IS NULL`
    )
    .all(sourceId) as { entity_id: number; surface: string }[];

  // Drop anything ambiguous across entities, comparing on the match key so
  // "Netanyahu" and "netanyahu" count as the same claim on the name.
  const owners = new Map<string, Set<number>>();
  for (const r of rows) {
    const key = normalize(r.surface);
    if (!key) continue;
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key)!.add(r.entity_id);
  }

  const out: Candidate[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    const surface = r.surface.trim();
    if (surface.length < MIN_ALIAS) continue;

    const key = normalize(surface);
    if (!key || (owners.get(key)?.size ?? 0) > 1) continue;

    const dedupe = `${r.entity_id}:${surface.toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    // Generic descriptions are not names. "the king" is an alias the extractor
    // records honestly and a terrible thing to search a whole book for.
    if (/^(the|a|an|his|her|their)\b/i.test(surface)) continue;

    const re = boundedRegex(surface);
    if (re) out.push({ entityId: r.entity_id, surface, re });
  }

  // Longest first, so "Benjamin Netanyahu" is tried before "Netanyahu" and the
  // recorded surface is the fuller one where the passage used it.
  return out.sort((a, b) => b.surface.length - a.surface.length);
}

/**
 * A whole-word match that also works in Arabic.
 *
 * `\b` is defined against the Latin word characters, so in Arabic it fires
 * between letters and matches fragments of unrelated words. Lookarounds on
 * Unicode letters and digits are the portable form.
 */
function boundedRegex(surface: string): RegExp | null {
  const escaped = surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u");
  } catch {
    return null;
  }
}

/**
 * The sentence a match sits in, so the quote reads as the source wrote it —
 * plus the sentence before it when the first one cannot stand alone.
 *
 * The sweep supplies about an eighth of all evidence and, unlike the extractor,
 * has no way to record what a quote refers back to: it reads one sentence and
 * nothing else. Taking the previous sentence when the matched one opens with
 * "Immediately," or a loose pronoun costs nothing, stays verbatim (the two are
 * contiguous text), and turns a quote that could not be used into one that can.
 *
 * It does not always work — the referent is often a paragraph back, not a
 * sentence — which is why the resolution pass exists as well. This is the free
 * half.
 */
function sentenceAround(text: string, at: number, length: number): string | null {
  const OPENERS = /[.!?؟\n]/;

  let start = at;
  while (start > 0 && !OPENERS.test(text[start - 1])) start--;

  let end = at + length;
  while (end < text.length && !OPENERS.test(text[end])) end++;
  if (end < text.length) end++; // keep the closing punctuation

  let quote = text.slice(start, end).trim();

  if (needsContext(quote).needs && start > 0) {
    let lead = start - 1;
    // Step over the punctuation that ended the previous sentence, then walk
    // back to where that sentence began.
    while (lead > 0 && OPENERS.test(text[lead - 1])) lead--;
    while (lead > 0 && !OPENERS.test(text[lead - 1])) lead--;

    const wider = text.slice(lead, end).trim();
    // Only if it stays quotable. A whole paragraph is not a quote.
    if (wider.length <= 700 && wider.length > quote.length) quote = wider;
  }

  // Too short to be evidence of anything; too long to be one sentence.
  if (quote.length < 25 || quote.length > 700) return null;
  return quote;
}
