import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { getConfig } from "../config";
import { normalize } from "../normalize";
import { bestName } from "../canonical";
import { finishTask } from "../queue";
import { correctionsForSource, discardIndex, isDiscarded } from "../audit";
import type { ChunkExtraction, EntityType, ExtractedEvent, Task } from "../types";
import { CLAIM_KINDS, ENTITY_TYPES } from "../types";
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
            description:
              "Three to six words fixing which one this is, e.g. 'Egyptian president 1954-1970'. In the interface language named in the rules.",
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
              "What this passage is talking about, in a few words, so the quote can be read years later without the source open: the episode, the moment, the person it concerns, and what any back-reference points at. Empty string only when the surrounding text gives you nothing to situate it with.",
          },
          fromContext: {
            type: Type.BOOLEAN,
            description:
              "True when this passage discusses the entity without naming it, and you took the name from EARLIER TEXT.",
          },
          attribution: {
            type: Type.STRING,
            description:
              "Who asserts the claim. \"source\" when the text states it in its own voice; otherwise the named person, body or document the text credits, or the text's own anonymous phrase (\"unnamed officials\", \"a person familiar with the talks\", \"anonymous\").",
          },
          claimKind: {
            type: Type.STRING,
            enum: CLAIM_KINDS as unknown as string[],
            description: "What sort of assertion the claim is. See the rules.",
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
          quote: { type: Type.STRING, description: "Verbatim sentence from the passage stating the relation. Copy exactly." },
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
          dateText: { type: Type.STRING, description: "The date as the source words it: 'yesterday', 'spring of 1956'." },
          dateIso: {
            type: Type.STRING,
            description:
              "Absolute, sortable form: 1956, 1956-03, or 1956-03-14. A relative date is resolved against the SOURCE published date. Empty when the text and the published date cannot fix one.",
          },
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

/**
 * The extraction rules, with the interface language filled in.
 *
 * The disambiguator is the one field a reader sees as a label rather than as
 * evidence, so it is written in the language the interface is in, not the
 * passage's. Written in the passage's language, an entity first met in an
 * Arabic source kept an Arabic label in an English interface for good.
 */
export function systemFor(interfaceLang: string): string {
  const lang = languageName(interfaceLang);
  return `You are an indexer building a research encyclopedia from primary sources —
books, articles, transcripts and documents — for a journalist.

From the PASSAGE you are given, extract every named person, organisation,
institution, event, place, work, and significant concept.

You may also be given EARLIER TEXT: the material immediately preceding the
passage. It is there for one purpose — to tell you what the passage is referring
back to. Never extract from it, never quote it, never record a claim that rests
only on it.

You are given a SOURCE header: who published the text, who wrote it, when, and
from where. Use it to resolve what the passage leaves relative — "yesterday",
"on Tuesday", "last month" — and for nothing else. It is not material to
extract from. A title used without a name ("the president", "the minister") is
resolved only from the PASSAGE or EARLIER TEXT; if neither names the person,
do not supply the name from what you know.

Rules that matter:
- Quote VERBATIM, and only from the PASSAGE. The "quote" field must be copied
  character-for-character. A researcher will click it to check you. Never
  paraphrase into a quote, never invent one. If you cannot quote it, do not
  claim it. The same holds for a relation's "quote".
- Use only what these texts say. Do not add anything you happen to know about
  these people or organisations from elsewhere. Outside knowledge is
  contamination — it is the one failure this tool exists to prevent.
- Write "claim" and "context" in the language of the passage. Write
  "disambiguator" in ${lang}, whatever language the passage is in: it is the
  label a reader of the encyclopedia sees, and the reader works in ${lang}.
- Give the name as the text writes it, in "surface". Do not translate it, do not
  expand it, do not correct its spelling.

TYPES. A proper noun keeps one type throughout a document; decide once and
hold to it.
- person: a named human being. Keep the name as written, rank and all.
- org: a body that is not an organ of a state — a company, a party, a
  movement, an army or militia, an NGO, a union, a media outlet, a university.
- institution: an organ of a state or of international law — a ministry, a
  court, a legislature, an agency, a central bank, a presidency, the UN and
  its bodies, the EU's bodies.
- place: geography and settlements only — a country, region, city, river,
  border, building. A government named by its capital ("Ottawa announced") is
  the institution, not the place.
- event: a dated happening — a war, an election, a summit, a strike, a
  signing, a ruling, an attack.
- work: a titled thing that can be cited — a document, a law, a bill, a
  treaty, a report, a book, a film, a speech.
- concept: only a term the source treats as a subject in its own right ("the
  resource curse", "sovereignty"), not every abstract noun.

ATTRIBUTION AND KIND. For every quote, say who is asserting it and what sort
of assertion it is.
- "attribution": "source" when the text states it in its own voice. Otherwise
  the person, body or document the text credits — "Finance Minister Freeland",
  "the ministry's statement", "the report" — or, when the text keeps them
  anonymous, its own phrase: "unnamed officials", "a person familiar with the
  talks", "anonymous". Never name an attributor the passage does not.
- "claimKind": fact (stated as a settled matter), allegation (asserted by one
  party against another, or under investigation), opinion (a judgement or
  argument), forecast (what will or may happen), denial (a rejection of a
  claim), quotation (direct speech recorded for its own sake).

DATES. Resolve relative dates against the published date in the SOURCE
header: "yesterday" in a piece published 2026-03-04 is 2026-03-03; "on
Tuesday" is the most recent Tuesday before publication unless the text says
otherwise; "last month" is the previous calendar month. Put the absolute form
in "dateIso" and keep the source's own wording in "dateText". When the text
plus the published date cannot fix a date, leave "dateIso" empty with
precision "unknown". Never invent one.

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
}

/** The rules as written for an English interface; the default and what tests read. */
export const SYSTEM = systemFor("en");

/** "ar" → "Arabic". Falls back to the tag itself for anything the runtime cannot name. */
export function languageName(tag: string): string {
  const t = (tag || "en").trim();
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(t) ?? t;
  } catch {
    return t;
  }
}

/** What extraction is told about where a passage came from. */
export interface SourceInfo {
  title: string;
  author: string | null;
  publisher: string | null;
  outlet: string | null;
  published_at: string | null;
  year: string | null;
  dateline: string | null;
  kind: string;
}

/**
 * The SOURCE header: outlet, author, published date, dateline, kind.
 *
 * Without it the model could not place "yesterday" or "on Tuesday", and every
 * event in a news item arrived undated. Books tolerated the omission; news
 * does not. The weekday is spelled out because "on Tuesday" is resolved
 * against it, and models miscount weekdays from a bare ISO date.
 */
export function sourceHeader(s: SourceInfo, where?: string): string {
  const lines = ["SOURCE", `  title: ${s.title}`, `  kind: ${kindLabel(s.kind)}`];
  const outlet = s.outlet ?? s.publisher;
  if (outlet) lines.push(`  ${s.kind === "url" || s.kind === "media" ? "outlet" : "publisher"}: ${outlet}`);
  if (s.author) lines.push(`  author: ${s.author}`);
  lines.push(`  published: ${describeDate(s.published_at, s.year)}`);
  if (s.dateline) lines.push(`  dateline: ${s.dateline}`);
  if (where) lines.push(`  location: ${where}`);
  return lines.join("\n");
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "url":
      return "article";
    case "media":
      return "transcript";
    case "epub":
      return "book";
    case "pdf":
      return "document";
    default:
      return "text";
  }
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function describeDate(publishedAt: string | null, year: string | null): string {
  const raw = publishedAt?.trim() || year?.trim();
  if (!raw) return "unknown";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!m) return raw;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(day.getTime())) return raw;
  const stamp = raw.includes("T") ? raw : raw.slice(0, 10);
  return `${stamp} (${WEEKDAYS[day.getUTCDay()]})`;
}

export async function handleExtract(task: Task): Promise<void> {
  const { chunkId } = JSON.parse(task.payload_json) as { chunkId: number };

  const chunk = db()
    .prepare(
      `SELECT c.*, s.title AS source_title, s.lang AS source_lang, s.author AS source_author,
              s.publisher AS source_publisher, s.outlet AS source_outlet,
              s.published_at AS source_published_at, s.year AS source_year,
              s.dateline AS source_dateline, s.kind AS source_kind,
              d.label AS doc_label
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
        source_author: string | null;
        source_publisher: string | null;
        source_outlet: string | null;
        source_published_at: string | null;
        source_year: string | null;
        source_dateline: string | null;
        source_kind: string;
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
  const header = sourceHeader(
    {
      title: chunk.source_title,
      author: chunk.source_author,
      publisher: chunk.source_publisher,
      outlet: chunk.source_outlet,
      published_at: chunk.source_published_at,
      year: chunk.source_year,
      dateline: chunk.source_dateline,
      kind: chunk.source_kind,
    },
    where
  );

  const { data, usage } = await generateJson<ChunkExtraction>({
    stage: "extract",
    // Routing honours the source's language: the cheap providers are weaker on
    // non-Latin scripts, and a name missed there is lost silently.
    lang: chunk.source_lang ?? undefined,
    sample: chunk.text.slice(0, 600),
    // What you have rejected from this source before, in your words. Appended
    // rather than woven in, so the standing rules stay one block and a
    // correction never quietly rewrites them.
    system: [systemFor(getConfig().entryLanguage), correctionsForSource(chunk.source_id)]
      .filter(Boolean)
      .join("\n\n"),
    schema: SCHEMA,
    parts: [
      [
        header,
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
      // A quote the model made up is worse than no quote at all. What is
      // stored is the passage's own text at the place the quote was found,
      // never the model's string: the locator tolerates a mangled tail, and
      // the tail it tolerates must not be what a reader is shown as verbatim.
      const quote = locateQuote(e.quote, chunk.text);
      if (!quote) continue;
      if (skipQuotes?.has(quoteKey(e.surface, quote))) continue;

      const entityId = upsertEntity(e.surface, e.type, e.disambiguator, chunk.source_id);

      // Resolved after the upsert rather than from the surface form, because
      // the ledger is keyed on the entity this passage resolves *to* — which is
      // frequently not what normalising this particular surface would give.
      if (rejected.size > 0) {
        const norm = (
          db().prepare("SELECT normalized FROM entities WHERE id=?").get(entityId) as
            | { normalized: string }
            | undefined
        )?.normalized;
        if (norm && isDiscarded(rejected, norm, quote)) continue;
      }

      const claimKind = e.claimKind && CLAIM_KINDS.includes(e.claimKind) ? e.claimKind : null;
      const attribution = e.attribution?.trim().slice(0, 200) || null;

      const mentionId = db()
        .prepare(
          `INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote, claim, context, confidence, attribution, claim_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          entityId,
          chunk.id,
          chunk.source_id,
          e.surface.trim(),
          quote,
          e.claim?.trim() ?? null,
          e.context?.trim() || null,
          // A name recovered from the surrounding text is a weaker record than
          // one the passage states outright, and is marked as such rather than
          // being either discarded or quietly treated as equal.
          e.fromContext ? 0.6 : 1.0,
          attribution,
          claimKind
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
      // A relation's quote is held to the same rule as an entity's. One with
      // no quote at all is kept, as before; one whose quote is not in the
      // passage is a fabrication and goes.
      let quote: string | null = null;
      if (r.quote?.trim()) {
        quote = locateQuote(r.quote, chunk.text);
        if (!quote) continue;
      }
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
          quote,
          r.context?.trim() || null
        );
      result.relations++;
    }

    for (const ev of data.events ?? []) {
      const entityId = entityIdBySurface.get(normalize(ev.entity ?? ""));
      if (!entityId || !ev.summary?.trim()) continue;
      const when = normaliseEventDate(ev);
      db()
        .prepare(
          `INSERT INTO events (entity_id, date_text, date_iso, precision, summary, source_id, mention_id, context)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          entityId,
          ev.dateText?.trim() || null,
          when.dateIso,
          when.precision,
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

const PRECISION_RANK: Record<string, number> = { day: 3, month: 2, year: 1, decade: 0, unknown: -1 };

/**
 * A sortable date and a precision that agree with each other.
 *
 * The model's "dateIso" arrived as "1956-3", "unknown" and "c. 1956"; its
 * precision as "century". The events table then held values nothing could
 * sort. Here the date is padded to ISO or dropped, and the precision can never
 * claim more than the date carries: "day" on a bare year becomes "year".
 */
export function normaliseEventDate(ev: Pick<ExtractedEvent, "dateIso" | "precision">): {
  dateIso: string | null;
  precision: string;
} {
  const m = /^\s*(?:c\.|ca\.|circa)?\s*(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?\s*$/i.exec(ev.dateIso ?? "");
  let iso: string | null = null;
  if (m) {
    iso = m[1];
    const month = m[2] ? Number(m[2]) : 0;
    const day = m[3] ? Number(m[3]) : 0;
    if (month >= 1 && month <= 12) {
      iso += `-${String(month).padStart(2, "0")}`;
      if (day >= 1 && day <= 31) iso += `-${String(day).padStart(2, "0")}`;
    }
  }
  const carried = !iso ? "unknown" : iso.length === 10 ? "day" : iso.length === 7 ? "month" : "year";
  const given = ev.precision && ev.precision in PRECISION_RANK ? ev.precision : carried;
  const precision = PRECISION_RANK[given] > PRECISION_RANK[carried] ? carried : given;
  return { dateIso: iso, precision };
}

/** Identity of a piece of evidence, for "have we already got this one?". */
export function quoteKey(surface: string, quote: string): string {
  return `${normalize(surface)}${quote.replace(/\s+/g, " ").trim().toLowerCase()}`;
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
 *
 * When more than one live entity carries the same key and type — identity
 * splits produce these, "Barak Ravid" twice — the one already holding
 * evidence from this source wins, then the one with most evidence. It used to
 * be whichever row SQLite returned first, so which twin a new quote landed on
 * was a coin toss, and the standing verdict from the split stopped resolve
 * from ever putting it right.
 */
function upsertEntity(surface: string, type: EntityType, disambiguator?: string, sourceId?: number): number {
  // The key depends on the type: a rank is stripped from a person's name but
  // never from an organisation's. See lib/normalize.ts.
  const norm = normalize(surface, type);
  const trimmed = surface.trim();
  const here = sourceId ?? -1;

  // One query over both ways of matching — the entity's own key or one of its
  // aliases — so the ranking sees every twin. Checked as two lookups, the
  // alias hit returned first and the twin matched only by key never competed.
  const existing = db()
    .prepare(
      `SELECT e.id,
              (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id = e.id AND m.source_id = ?) AS here,
              (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id = e.id) AS total
         FROM entities e
        WHERE e.type = ? AND e.merged_into IS NULL
          AND (e.normalized = ?
               OR EXISTS (SELECT 1 FROM aliases a WHERE a.entity_id = e.id AND a.normalized = ?))
        ORDER BY here DESC, total DESC, e.id
        LIMIT 1`
    )
    .get(here, type, norm, norm) as { id: number } | undefined;
  if (existing) return remember(existing.id, trimmed, norm, type, disambiguator);

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
      .run(type, heading, norm, disambiguator?.trim() || null).lastInsertRowid
  );
  db()
    .prepare("INSERT OR IGNORE INTO aliases (entity_id, surface, normalized) VALUES (?, ?, ?)")
    .run(id, trimmed, norm);
  return id;
}

/**
 * Records a surface form against an entity we already have, and upgrades the
 * display name and the disambiguator if this reading offers better ones.
 *
 * The first surface seen used to become the heading for good, which is how
 * entries ended up titled "President Truman" while holding "Harry S. Truman"
 * as an alias. Identity was right; the label was an accident of ordering. The
 * disambiguator had the same defect: only the first extraction's was kept, so
 * "Egyptian president" never grew into "Egyptian president 1954-1970" however
 * many later passages offered it.
 */
function remember(
  entityId: number,
  surface: string,
  norm: string,
  type: EntityType,
  disambiguator?: string
): number {
  db()
    .prepare("INSERT OR IGNORE INTO aliases (entity_id, surface, normalized) VALUES (?, ?, ?)")
    .run(entityId, surface, norm);

  const row = db()
    .prepare("SELECT canonical_name, disambiguator FROM entities WHERE id=?")
    .get(entityId) as { canonical_name: string; disambiguator: string | null } | undefined;
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

  const next = disambiguator?.trim();
  if (next && (!row.disambiguator || moreSpecific(next, row.disambiguator))) {
    db()
      .prepare("UPDATE entities SET disambiguator=? WHERE id=? AND name_locked=0")
      .run(next, entityId);
  }

  return entityId;
}

/**
 * Whether a new disambiguator says more than the one on record: more words
 * and more characters, not merely different ones. Either alone would let
 * labels churn between equally good phrasings on every extraction.
 */
function moreSpecific(next: string, current: string): boolean {
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  return words(next) > words(current) && next.length > current.length;
}

/**
 * Finds a quote in the passage and returns the passage's own text for it.
 *
 * This is the guard against the one failure that would make the tool useless:
 * a fabricated quote. It used to answer yes or no and let the caller store the
 * model's string, tolerating a match on the first 60% of it — so a quote whose
 * tail the model had mangled was stored, tail and all, as verbatim. Six in six
 * hundred sampled quotes were like that. Now the match is mapped back to the
 * original characters: whitespace is collapsed and typographic quotes folded
 * for the comparison only, and what comes back is a substring of the chunk.
 *
 * A head-only match is still accepted, but the stored text runs from the head
 * to the end of that sentence in the passage, not to the end of what the model
 * wrote. Returns null when the quote is not there.
 */
export function locateQuote(quote: string, text: string): string | null {
  const q = flatten(quote).flat;
  if (q.length < 8) return null;
  const hay = flatten(text);

  let at = hay.flat.indexOf(q);
  if (at >= 0) return original(text, hay.map, at, at + q.length);

  // Tolerate a mangled tail (ellipses, trimmed punctuation) but not a mangled claim.
  const head = q.slice(0, Math.max(40, Math.floor(q.length * 0.6)));
  at = hay.flat.indexOf(head);
  if (at < 0) return null;

  const from = at + head.length;
  // Extend to the end of the sentence the head sits in, within reason: a
  // sentence longer than the quote plus a generous margin is a run-on the
  // model would not have quoted.
  const limit = Math.min(hay.flat.length, from + Math.max(q.length, 200));
  const stop = /[.!?؟。]+["'”’)\]»]*(?=\s|$)/g;
  stop.lastIndex = from;
  const found = stop.exec(hay.flat);
  let end: number;
  if (found && found.index + found[0].length <= limit) {
    end = found.index + found[0].length;
  } else if (limit >= hay.flat.length) {
    end = hay.flat.length;
  } else {
    // No sentence end in reach: stop at a word boundary rather than mid-word.
    const space = hay.flat.lastIndexOf(" ", limit);
    end = space > from ? space : limit;
  }
  return original(text, hay.map, at, end);
}

/**
 * The text with whitespace runs collapsed to one space, curly quotes
 * straightened and letters lower-cased — and, for every character of the
 * result, the index it came from. Lower-casing is done per character so the
 * map stays one-to-one; the rare letter whose lower-case form is longer keeps
 * its original.
 */
function flatten(s: string): { flat: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (chars.length) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      chars.push(" ");
      map.push(i - 1);
      pendingSpace = false;
    }
    let out = FOLD[ch] ?? ch.toLowerCase();
    if (out.length !== 1) out = ch;
    chars.push(out);
    map.push(i);
  }
  return { flat: chars.join(""), map };
}

const FOLD: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "«": '"', "»": '"',
  "–": "-", "—": "-", "−": "-",
  " ": " ",
};

/** The original text between two positions of its flattened form. */
function original(text: string, map: number[], start: number, end: number): string | null {
  if (end <= start || start >= map.length) return null;
  const s = map[start];
  const e = map[Math.min(end, map.length) - 1] + 1;
  const out = text.slice(s, e).trim();
  return out || null;
}
