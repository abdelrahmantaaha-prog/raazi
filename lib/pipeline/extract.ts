import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { normalize } from "../normalize";
import { bestName } from "../canonical";
import { finishTask } from "../queue";
import { correctionsForSource, discardIndex, isDiscarded } from "../audit";
import type { ChunkExtraction, EntityType, Task } from "../types";
import { ENTITY_TYPES } from "../types";
import { formatLocator } from "../chunk";

export const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    entities: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          surface: { type: Type.STRING, description: "The name exactly as written in this passage." },
          type: { type: Type.STRING, enum: ENTITY_TYPES as unknown as string[] },
          disambiguator: {
            type: Type.STRING,
            description: "Three to six words fixing which one this is, e.g. 'Egyptian president 1954-1970'.",
          },
          claim: {
            type: Type.STRING,
            description: "What this passage specifically asserts about them. One sentence.",
          },
          quote: {
            type: Type.STRING,
            description: "Verbatim sentence(s) from the passage supporting the claim. Copy exactly.",
          },
          context: {
            type: Type.STRING,
            description:
              "What this passage is talking about, in a few words, so the quote can be read years later without the book open. Say when and what episode it belongs to, and resolve any back-reference it leans on, drawn from EARLIER TEXT or this passage. Example: quote says 'following one incident'; context says 'the 2015 Mina stampede during the hajj, in which hundreds of Iranian pilgrims died'. Another: quote mentions unemployment at 14 percent; context says 'Thomas Barger taking a mining job during the Depression, early 1930s'. Empty string only when the passage genuinely gives you nothing to situate it with.",
          },
          fromContext: {
            type: Type.BOOLEAN,
            description:
              "True when this passage discusses the entity without naming it, and you took the name from EARLIER TEXT.",
          },
        },
        required: ["surface", "type", "quote"],
      },
    },
    relations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          from: { type: Type.STRING },
          to: { type: Type.STRING },
          type: { type: Type.STRING, description: "Short verb phrase: 'founded', 'served under', 'met with'." },
          quote: { type: Type.STRING },
          context: {
            type: Type.STRING,
            description: "What the quote refers back to, if anything. Empty string otherwise.",
          },
        },
        required: ["from", "to", "type"],
      },
    },
    events: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          entity: { type: Type.STRING, description: "Which named entity this event belongs to." },
          dateText: { type: Type.STRING, description: "The date as the source words it." },
          dateIso: { type: Type.STRING, description: "Sortable form: 1956, 1956-03, or 1956-03-14." },
          precision: { type: Type.STRING, enum: ["day", "month", "year", "decade", "unknown"] },
          summary: { type: Type.STRING },
          context: {
            type: Type.STRING,
            description: "What the event refers back to, if anything. Empty string otherwise.",
          },
        },
        required: ["entity", "summary"],
      },
    },
  },
  required: ["entities", "relations", "events"],
};

export const SYSTEM = `You are an indexer building a research encyclopedia from primary sources.

From the PASSAGE you are given, extract every named person, company, institution,
event, place, work, and significant concept.

You may also be given EARLIER TEXT: the material immediately preceding the
passage. It is there for one purpose — to tell you what the passage is referring
back to. Never extract from it, never quote it, never record a claim that rests
only on it.

Rules that matter:
- Quote VERBATIM, and only from the PASSAGE. The "quote" field must be copied
  character-for-character. A researcher will click it to check you. Never
  paraphrase into a quote, never invent one. If you cannot quote it, do not
  claim it.
- Use only what these texts say. Do not add anything you happen to know about
  these people or organisations from elsewhere. Outside knowledge is
  contamination — it is the one failure this tool exists to prevent.
- Write "claim", "context" and "disambiguator" in the language of the passage.
- Give the name as the text writes it, in "surface". Do not translate it, do not
  expand it, do not correct its spelling.
- A concept qualifies only if the source treats it as a subject in its own right,
  not for every abstract noun.

BACK-REFERENCES. This is the part that is usually done badly, so read it twice.

Sources refer to things they have already introduced without naming them again:
"following one incident", "the agreement", "the massacre", "the company", "he".
A quote carrying one of these is useless on its own — the reader is left asking
"which incident?" — and the answer is almost always sitting a sentence or a
paragraph back.

But the narrow case — an explicit back-reference — is not the only way a quote
arrives unreadable. Fill "context" for EVERY quote with what the passage is
actually talking about: the episode, the moment, the person it concerns. You are
reading the surrounding text right now and will never read it again, and nothing
downstream can recover what you leave out.

  quote:   "Following one incident for which Iran blamed Saudi Arabia, Tehran
            went so far as to suggest transferring custody of the Two Holy
            Mosques to Iran."
  context: "the 2015 Mina stampede during the hajj, in which hundreds of Iranian
            pilgrims were killed"

  quote:   "Though relieved to have any job at a time when unemployment hit 14
            percent, Barger desperately wanted to get out of the mine."
  context: "Thomas Barger taking a mining job in the early 1930s, before joining
            Standard Oil of California in Arabia"

The second is the one that used to be missed. Nothing in it is a back-reference,
and without the gloss it becomes "unemployment reached 14 percent at some point"
— a sentence that is true, cited, and worth nothing.

If the surrounding text genuinely does not situate the passage, leave "context"
empty. Do not guess it, and do not reach for what you know from outside. An
unresolved reference recorded honestly is fine; an invented one is not.

An entity the passage discusses without ever naming — "the company announced",
where the company was named a paragraph earlier — should still be extracted.
Take the name from EARLIER TEXT, quote the passage as usual, and set
"fromContext" to true so the record shows the name came from context.

Skip bare pronouns where even the surrounding text does not settle who is meant.`;

export async function handleExtract(task: Task): Promise<void> {
  const { chunkId } = JSON.parse(task.payload_json) as { chunkId: number };

  const chunk = db()
    .prepare(
      `SELECT c.*, s.title AS source_title, s.lang AS source_lang, d.label AS doc_label
         FROM chunks c
         JOIN sources s ON s.id = c.source_id
    LEFT JOIN documents d ON d.id = c.doc_id
        WHERE c.id = ?`
    )
    .get(chunkId) as
    | {
        id: number;
        source_id: number;
        seq: number;
        text: string;
        locator_json: string;
        extracted_at: string | null;
        source_title: string;
        source_lang: string | null;
        doc_label: string | null;
      }
    | undefined;

  if (!chunk) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Chunk no longer exists.");
    return;
  }
  // Idempotence: a task re-queued after a crash must not double-write.
  if (chunk.extracted_at) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Already extracted.");
    return;
  }

  const locator = JSON.parse(chunk.locator_json) as Record<string, unknown>;
  const where = formatLocator(locator, chunk.doc_label);
  const earlier = precedingText(chunk.source_id, chunk.seq);

  const { data, usage } = await generateJson<ChunkExtraction>({
    stage: "extract",
    // Routing honours the source's language: the cheap providers are weaker on
    // non-Latin scripts, and a name missed there is lost silently.
    lang: chunk.source_lang ?? undefined,
    sample: chunk.text.slice(0, 600),
    // What you have rejected from this source before, in your words. Appended
    // rather than woven in, so the standing rules stay one block and a
    // correction never quietly rewrites them.
    system: [SYSTEM, correctionsForSource(chunk.source_id)].filter(Boolean).join("\n\n"),
    schema: SCHEMA,
    parts: [
      [
        `Source: ${chunk.source_title}${where ? ` — ${where}` : ""}`,
        earlier
          ? `\nEARLIER TEXT (context only — do not extract or quote from this):\n"""\n${earlier}\n"""`
          : "",
        `\nPASSAGE:\n"""\n${chunk.text}\n"""`,
      ].join("\n"),
    ],
  });

  // Everything below is pure DB work, so it commits or it doesn't.
  tx(() => {
    persist(chunk, data);
    db().prepare("UPDATE chunks SET extracted_at=datetime('now') WHERE id=?").run(chunk.id);
    finishTask(task.id, task.run_id, usage);
  });
}

export interface TargetChunk {
  id: number;
  source_id: number;
  text: string;
}

export interface PersistResult {
  mentions: number;
  relations: number;
  events: number;
}

/**
 * Writes an extraction against a chunk. Shared by the first read and by
 * Enhance, so the guarantees — verified quotes, no self-relations, entries
 * marked stale when their evidence grows — hold identically whichever pass
 * produced the material. Caller supplies the transaction.
 *
 * `skipQuotes` are quotes already on record for this chunk; anything matching
 * one is dropped. Enhance is meant to add what was missed, not to file a second
 * copy of what the first pass already found.
 */
export function persist(
  chunk: TargetChunk,
  data: ChunkExtraction,
  skipQuotes?: Set<string>
): PersistResult {
  const result: PersistResult = { mentions: 0, relations: 0, events: 0 };
  {
    const mentionIdBySurface = new Map<string, number>();
    const entityIdBySurface = new Map<string, number>();

    // Verdicts you have already given. Checked here rather than only at read
    // time because this is the path a re-extraction takes: the mention rows
    // carrying your marks are deleted wholesale and written again from scratch,
    // and without this the rejected passage would come back unmarked.
    const rejected = discardIndex();

    for (const e of data.entities ?? []) {
      if (!e.surface?.trim() || !e.quote?.trim()) continue;
      if (!ENTITY_TYPES.includes(e.type)) continue;
      // A quote the model made up is worse than no quote at all.
      if (!quoteAppearsIn(e.quote, chunk.text)) continue;
      if (skipQuotes?.has(quoteKey(e.surface, e.quote))) continue;

      const entityId = upsertEntity(e.surface, e.type, e.disambiguator);

      // Resolved after the upsert rather than from the surface form, because
      // the ledger is keyed on the entity this passage resolves *to* — which is
      // frequently not what normalising this particular surface would give.
      if (rejected.size > 0) {
        const norm = (
          db().prepare("SELECT normalized FROM entities WHERE id=?").get(entityId) as
            | { normalized: string }
            | undefined
        )?.normalized;
        if (norm && isDiscarded(rejected, norm, e.quote.trim())) continue;
      }

      const mentionId = db()
        .prepare(
          `INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote, claim, context, confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          entityId,
          chunk.id,
          chunk.source_id,
          e.surface.trim(),
          e.quote.trim(),
          e.claim?.trim() ?? null,
          e.context?.trim() || null,
          // A name recovered from the surrounding text is a weaker record than
          // one the passage states outright, and is marked as such rather than
          // being either discarded or quietly treated as equal.
          e.fromContext ? 0.6 : 1.0
        )
        .lastInsertRowid;

      entityIdBySurface.set(normalize(e.surface), entityId);
      mentionIdBySurface.set(normalize(e.surface), Number(mentionId));
      result.mentions++;

      // New evidence means any existing entry no longer reflects the record.
      db()
        .prepare("UPDATE entities SET entry_state='stale' WHERE id=? AND entry_state='fresh'")
        .run(entityId);
    }

    for (const r of data.relations ?? []) {
      const from = entityIdBySurface.get(normalize(r.from ?? ""));
      const to = entityIdBySurface.get(normalize(r.to ?? ""));
      if (!from || !to || from === to) continue;
      db()
        .prepare(
          `INSERT INTO relations (from_entity, to_entity, type, source_id, mention_id, quote, context)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          from,
          to,
          r.type.trim(),
          chunk.source_id,
          mentionIdBySurface.get(normalize(r.from)) ?? null,
          r.quote ?? null,
          r.context?.trim() || null
        );
      result.relations++;
    }

    for (const ev of data.events ?? []) {
      const entityId = entityIdBySurface.get(normalize(ev.entity ?? ""));
      if (!entityId || !ev.summary?.trim()) continue;
      db()
        .prepare(
          `INSERT INTO events (entity_id, date_text, date_iso, precision, summary, source_id, mention_id, context)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          entityId,
          ev.dateText ?? null,
          ev.dateIso ?? null,
          ev.precision ?? "unknown",
          ev.summary.trim(),
          chunk.source_id,
          mentionIdBySurface.get(normalize(ev.entity)) ?? null,
          ev.context?.trim() || null
        );
      result.events++;
    }
  }
  return result;
}

/** Identity of a piece of evidence, for "have we already got this one?". */
export function quoteKey(surface: string, quote: string): string {
  return `${normalize(surface)}${quote.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

/**
 * How much of the preceding chunk to show the extractor.
 *
 * The chunker already carries ~250 tokens of overlap forward so a sentence
 * spanning a seam stays intact, which is not nearly enough to resolve "the
 * agreement" back to the paragraph that named it. This is bigger, and unlike
 * the overlap it is labelled as context rather than as material — so the model
 * can read it without extracting from it twice.
 *
 * Roughly 900 tokens. Cheap next to a 3,500-token passage, and it is the
 * difference between a quote a researcher can use and one that leaves them
 * asking "which incident?".
 */
const CONTEXT_CHARS = 3600;

/** The tail of the chunk before this one, for resolving back-references. */
export function precedingText(sourceId: number, seq: number): string | null {
  if (seq <= 0) return null;

  const row = db()
    .prepare("SELECT text FROM chunks WHERE source_id=? AND seq<? ORDER BY seq DESC LIMIT 1")
    .get(sourceId, seq) as { text: string } | undefined;
  if (!row?.text) return null;

  if (row.text.length <= CONTEXT_CHARS) return row.text;

  // Start at a paragraph break where there is one nearby, so the context does
  // not open mid-sentence.
  const tail = row.text.slice(-CONTEXT_CHARS);
  const at = tail.indexOf("\n\n");
  return (at >= 0 && at < CONTEXT_CHARS * 0.3 ? tail.slice(at + 2) : tail).trim();
}

/**
 * Cheap resolution, run inline: exact alias hit or nothing. Fuzzy matching and
 * anything needing judgement is deferred to the resolve pass, which sees the
 * whole source at once and can afford to be careful.
 */
function upsertEntity(surface: string, type: EntityType, disambiguator?: string): number {
  // The key depends on the type: a rank is stripped from a person's name but
  // never from an organisation's. See lib/normalize.ts.
  const norm = normalize(surface, type);
  const trimmed = surface.trim();

  const viaAlias = db()
    .prepare(
      `SELECT e.id FROM aliases a JOIN entities e ON e.id = a.entity_id
        WHERE a.normalized = ? AND e.type = ? AND e.merged_into IS NULL LIMIT 1`
    )
    .get(norm, type) as { id: number } | undefined;
  if (viaAlias) return remember(viaAlias.id, trimmed, norm, type);

  const direct = db()
    .prepare(
      "SELECT id FROM entities WHERE normalized=? AND type=? AND merged_into IS NULL LIMIT 1"
    )
    .get(norm, type) as { id: number } | undefined;
  if (direct) return remember(direct.id, trimmed, norm, type);

  // A brand-new entity gets its heading cleaned up too. Without this the very
  // first surface form becomes the name for good, which is how "Senator Jon
  // Ossoff" and "Dr. Deborah Birx" ended up as headings — the alias below
  // keeps the form the source actually used.
  const heading = bestName(trimmed, [trimmed], type) ?? trimmed;

  const id = Number(
    db()
      .prepare(
        `INSERT INTO entities (type, canonical_name, normalized, disambiguator)
         VALUES (?, ?, ?, ?)`
      )
      .run(type, heading, norm, disambiguator?.trim() ?? null).lastInsertRowid
  );
  db()
    .prepare("INSERT OR IGNORE INTO aliases (entity_id, surface, normalized) VALUES (?, ?, ?)")
    .run(id, trimmed, norm);
  return id;
}

/**
 * Records a surface form against an entity we already have, and upgrades the
 * display name if this form is a better one.
 *
 * The first surface seen used to become the heading for good, which is how
 * entries ended up titled "President Truman" while holding "Harry S. Truman"
 * as an alias. Identity was right; the label was an accident of ordering.
 */
function remember(entityId: number, surface: string, norm: string, type: EntityType): number {
  db()
    .prepare("INSERT OR IGNORE INTO aliases (entity_id, surface, normalized) VALUES (?, ?, ?)")
    .run(entityId, surface, norm);

  const row = db()
    .prepare("SELECT canonical_name FROM entities WHERE id=?")
    .get(entityId) as { canonical_name: string } | undefined;
  if (!row) return entityId;

  const aliases = (
    db().prepare("SELECT surface FROM aliases WHERE entity_id=?").all(entityId) as {
      surface: string;
    }[]
  ).map((a) => a.surface);

  // A heading you picked yourself is final; the scorer does not get a vote.
  const better = bestName(row.canonical_name, aliases, type);
  if (better) {
    db()
      .prepare("UPDATE entities SET canonical_name=? WHERE id=? AND name_locked=0")
      .run(better, entityId);
  }

  return entityId;
}

/**
 * Guards against the one failure mode that would make this tool useless: a
 * fabricated quote. Compared on collapsed whitespace, since models normalise
 * line breaks inside quotes.
 */
function quoteAppearsIn(quote: string, text: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const q = flat(quote);
  if (q.length < 8) return false;
  const haystack = flat(text);
  if (haystack.includes(q)) return true;
  // Tolerate a mangled tail (ellipses, trimmed punctuation) but not a mangled claim.
  const head = q.slice(0, Math.max(40, Math.floor(q.length * 0.6)));
  return haystack.includes(head);
}
