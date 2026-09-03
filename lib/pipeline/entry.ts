import crypto from "node:crypto";
import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { getConfig } from "../config";
import { enqueue, finishTask } from "../queue";
import { correctionsFor } from "../audit";
import { dedupeByQuote, isFromContext, type Task } from "../types";
import { formatLocator } from "../chunk";
import { citedIds as citedIdsOf, normaliseMarkers } from "../markers";
import { paragraphSentences } from "../sentences";

/**
 * An entry is never authored once and left alone — it is a function of the
 * evidence, and the evidence grows. `built_from_hash` records exactly which
 * mentions produced the current text; when that set changes the entity goes
 * stale and this runs again.
 *
 * How it is written changed on 2026-09-03, and the reason is worth keeping.
 * Entries used to be assembled in passes of forty quotes, each pass bolting
 * new material onto the last, and revised the same way. Every sentence was
 * true and cited, and the result read as an index: a man's schooling, a
 * lawsuit and a shipping contract in one paragraph because three quotes came
 * from one book, with no thread between them. A separate "coherence" pass
 * then tried to reorganise prose it was forbidden to understand.
 *
 * The writer now sees everything at once — every passage, the dated events,
 * the recorded relations, and the previous version — and writes the entry as
 * a whole, from a plan it makes first. It is asked for an account, not a list:
 * a spine (time for people and events, theme for institutions and places), one
 * subject per paragraph, and connections only where the sources state them.
 * Cost is one call, two for a large subject, instead of up to eleven.
 */

interface MentionRow {
  id: number;
  quote: string;
  claim: string | null;
  context: string | null;
  confidence: number;
  surface: string;
  attribution: string | null;
  claim_kind: string | null;
  source_id: number;
  source_title: string;
  source_author: string | null;
  source_lang: string | null;
  source_year: string | null;
  source_kind: string | null;
  source_outlet: string | null;
  published_at: string | null;
  locator_json: string;
  doc_label: string | null;
}

/**
 * The plan comes first in the schema on purpose: a model fills JSON in
 * property order, so it has to decide the shape of the entry before it writes
 * a word of it. That ordering is most of what turned lists into prose.
 */
const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    plan: {
      type: Type.ARRAY,
      description:
        "The entry's sections in order, decided before writing. Each names its subject and the passages it will draw on.",
      items: {
        type: Type.OBJECT,
        properties: {
          heading: { type: Type.STRING, description: "Short section heading, or 'opening' for the lead." },
          about: { type: Type.STRING, description: "One sentence: what this section establishes." },
          mentionIds: { type: Type.ARRAY, items: { type: Type.INTEGER } },
        },
        required: ["heading", "mentionIds"],
      },
    },
    summary: {
      type: Type.STRING,
      description:
        "One or two sentences identifying who or what this is, saying only what the body says. No citations.",
    },
    body: {
      type: Type.STRING,
      description:
        "The entry in Markdown, following the plan. Every factual sentence ends with citation markers of the form [[m:ID]], written one per id and separated by spaces.",
    },
    changelog: {
      type: Type.STRING,
      description:
        "Markdown bullets naming what changed against the previous version: added, corrected, complicated, removed. Empty string on a first draft.",
    },
    contradictions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          claimA: { type: Type.STRING, description: "One account." },
          claimB: { type: Type.STRING, description: "The account that disagrees with it." },
          mentionA: { type: Type.INTEGER, description: "Mention ID supporting claim A." },
          mentionB: { type: Type.INTEGER, description: "Mention ID supporting claim B." },
        },
        required: ["claimA", "claimB"],
      },
    },
  },
  required: ["plan", "summary", "body"],
};

const PLAN_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    spine: {
      type: Type.STRING,
      enum: ["chronological", "thematic"],
      description: "How the entry is organised overall.",
    },
    sections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          heading: { type: Type.STRING },
          about: { type: Type.STRING, description: "One sentence: what this section establishes." },
          mentionIds: { type: Type.ARRAY, items: { type: Type.INTEGER } },
        },
        required: ["heading", "mentionIds"],
      },
    },
    leaveOut: {
      type: Type.ARRAY,
      description: "Passages that add nothing usable, with the id only.",
      items: { type: Type.INTEGER },
    },
  },
  required: ["spine", "sections"],
};

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ar: "Arabic",
  fr: "French",
  es: "Spanish",
  de: "German",
  tr: "Turkish",
  fa: "Persian",
  he: "Hebrew",
  ru: "Russian",
};

function languageName(tag: string): string {
  return LANGUAGE_NAMES[tag.toLowerCase().split("-")[0]] ?? tag;
}

/** What a good entry of each kind is shaped like. Guidance, not a template. */
const SHAPES: Record<string, string> = {
  person: `For a person: who they are and what they are known for in these sources;
then their life and work in time order — origins, positions held, what they did
and said in each; their relationships (family, patrons, rivals, employers) where
the sources record them; then what is contested or unclear.`,
  org: `For a company, party, movement or army: what it is and what it does
according to these sources; who leads or owns it; its actions and dealings in
time order; disputes and controversies; what is contested.`,
  institution: `For a state or international body: its mandate as the sources
describe it; who ran it and when; what it decided, ordered or investigated, in
time order; how others treated it; what is contested.`,
  event: `For an event: what happened, where and when; who was involved and what
each did; what led to it and what followed, only as the sources state; where the
accounts differ.`,
  place: `For a place: what the sources say it is; what happened there, in time
order; who is associated with it; how it is described or contested.`,
  work: `For a document, law, treaty or book: what it is, who made it and when;
what it says or does according to the sources; how it was received, applied or
argued over.`,
  concept: `For a concept: how the sources define or use it; who advances or
disputes it; the episodes in which it matters, in time order.`,
};

const SYSTEM_BASE = `You write encyclopedia entries for a researcher's private reference work,
built strictly from the passages they have collected. The researcher is a
political journalist who will cite these entries; they must be exact, and they
must read as one account rather than a list of facts.

ABSOLUTE RULES

- Every factual sentence ends with at least one citation marker naming the
  passage it rests on. A sentence you cannot cite is a sentence you must not
  write. The one exception is described under FLOW.
- Use only the evidence supplied. You know a great deal about these subjects
  from training; leaving it out is the entire point. This entry documents what
  THESE SOURCES say, and will be cited as such.
- Do not open with a definition the evidence does not contain. If the passages
  never say what this thing is, begin with what they do establish.
- Where sources disagree, say so in the entry, attribute each side to its work,
  and report the pair in "contradictions". Never silently pick a winner.
- Attribute contested and reported claims: "According to Heikal, …", "officials
  told the Post that …". An "attributed to" line under a quote tells you whose
  claim it is; an "allegation", "opinion", "forecast" or "denial" marking tells
  you it is not a settled fact and must not be written as one.
- No invented dates, titles, relationships or causes. Uncertainty stated plainly
  is worth more than confident filler.
- NAME PEOPLE IN FULL THE FIRST TIME, including the subject: "Crown Prince
  Feisal bin Abdulaziz", not "Feisal"; "Steve Bechtel", not "Bechtel". These
  sources are full of families who share a name. Short forms are fine after.
- An "in context" line under a quote says what that passage is about — the
  episode, the moment. Use it: write "following the 2015 Mina stampede" rather
  than copying "following one incident". Where a quote turns on something vague
  and no context line settles it, leave that quote out rather than write a
  sentence whose whole content is that something happened at some time.
- A "note" line saying the passage did not name the subject means the evidence
  is weaker; do not build a central claim on it alone.

FLOW — this is what separates an entry from an index

Plan before you write. Choose a spine: time, for people and events; theme, for
institutions, places and concepts — and within a thematic section, time order.
Then write so that a reader who knows nothing follows the account:

- One subject per paragraph. Facts that share a paragraph must share a subject,
  a period, or a stated connection — never merely a source.
- Each paragraph may open with ONE framing sentence that says what the
  paragraph establishes ("Barger's rise at Aramco was rapid."). It carries no
  marker only if every fact in it is cited later in the same paragraph and it
  adds nothing of its own. Anything more specific than a summary of its own
  paragraph must be cited.
- Connect facts by the connections the sources state: sequence, cause, response,
  reversal. "After the embargo, …" is allowed when a passage places it after the
  embargo; it is not allowed because you know the dates. When two facts are not
  connected by the evidence, they go in different paragraphs, not one sentence.
- Put dates in the prose where the sources give them; the entry should let a
  reader reconstruct the order of events without a table.
- Do not enumerate. No paragraph that is a sequence of unrelated cited sentences.
  If the only way to use a passage is to append an unconnected sentence, leave
  the passage out; you are not scored on how many passages you cite.
- Headings name subjects ("Oil negotiations, 1950–52"), not categories
  ("Facts", "Other information"). Short entries need no headings at all.

LENGTH follows evidence: roughly one paragraph for every three to five usable
passages, never padded. A subject with four passages is one paragraph.

FORMAT
- Citation markers are written [[m:12]]. Several markers are written one after
  another with a space: [[m:12]] [[m:15]]. Never [[m:12], [m:15]] and never
  [[m:12, m:15]] — those cannot be read and the sentence loses its citations.
- A heading goes on its own line with a blank line before and after; never a
  "##" in the middle of a line of prose. Blank lines between paragraphs.
- The summary is one or two plain sentences with no markers, saying only what
  the body says.

REVISIONS: when a previous version is supplied, write the whole entry afresh
from all the evidence — do not append to the old text — but keep its wording
where it was right, keep its citation markers where they still hold, and put
what changed in the changelog.`;

const PLAN_SYSTEM = `You are planning an encyclopedia entry before it is written, for a researcher
who will cite it. You are given every passage collected about the subject, each
with its id, date, and a one-line gist. Decide the shape of the entry.

- Choose the spine: chronological for people and events, thematic for
  institutions, places and concepts. Within a thematic section, time order.
- Group passages into sections by SUBJECT, never by which book they came from.
  A section is a subject the reader would want to follow: an office held, an
  episode, a relationship, a dispute.
- Order the sections so the account builds: identity first, then the sequence
  of things, then what is contested.
- Passages that repeat another, or that say nothing usable about the subject,
  go in leaveOut with a clear conscience.
- Do not write the entry, and do not add anything you know from outside the
  passages.`;

/** Above this the writer gets a plan from a separate, cheaper call first. */
const PLAN_THRESHOLD = 60;

/** How much evidence one write may be given. */
const MAX_EVIDENCE = 160;

/**
 * How many times the writer may be run against the same evidence before it is
 * told to stop. Two rewrites is the morning routine's allowance for a flagged
 * entry; a third means the flags are the verifier's, not the entry's.
 */
export const MAX_REWRITES_PER_EVIDENCE = 3;

export async function handleEntry(task: Task): Promise<void> {
  const { entityId, force, fromFlags } = JSON.parse(task.payload_json) as {
    entityId: number;
    /** Set when you asked for this by hand, which overrides "already current". */
    force?: boolean;
    /** Set by the morning routine: a rewrite because verification flagged it. */
    fromFlags?: boolean;
  };
  const free = { tokensIn: 0, tokensOut: 0 };

  const entity = db()
    .prepare("SELECT * FROM entities WHERE id=? AND merged_into IS NULL")
    .get(entityId) as
    | { id: number; canonical_name: string; type: string; disambiguator: string | null; entry_state: string }
    | undefined;

  if (!entity) {
    finishTask(task.id, task.run_id, free, "skipped", "Entity was merged away.");
    return;
  }

  const mentions = mentionsFor(entityId);
  if (mentions.length === 0) {
    finishTask(task.id, task.run_id, free, "skipped", "No evidence.");
    return;
  }

  const hash = hashOf(mentions.map((m) => m.id));
  const existing = db()
    .prepare("SELECT * FROM entries WHERE entity_id=?")
    .get(entityId) as
    | {
        entity_id: number;
        summary: string;
        body_md: string;
        built_from_hash: string;
        passes: number;
        flag_rewrites: number;
        lang: string | null;
      }
    | undefined;

  const sameEvidence = existing?.built_from_hash === hash;
  const language = getConfig().entryLanguage || "en";
  const languageChanged = Boolean(existing && existing.lang && existing.lang !== language);

  // Nothing new to say — unless you asked, or the language you read in changed.
  if (!force && sameEvidence && !languageChanged) {
    tx(() => {
      db().prepare("UPDATE entities SET entry_state='fresh' WHERE id=?").run(entityId);
      finishTask(task.id, task.run_id, free, "skipped", "Already current.");
    });
    return;
  }

  // The memory the old loop lacked. A rewrite against unchanged evidence is
  // allowed a few times — you may not like the draft, verification may have
  // flagged it — and then refused until the evidence moves, whoever asks.
  if (existing && sameEvidence && existing.passes >= MAX_REWRITES_PER_EVIDENCE) {
    tx(() => {
      db().prepare("UPDATE entities SET entry_state='fresh' WHERE id=?").run(entityId);
      finishTask(
        task.id,
        task.run_id,
        free,
        "skipped",
        `Already rewritten ${existing.passes} times against this evidence; not again until it changes.`
      );
    });
    return;
  }

  // Everything the writer will see.
  const { evidence, leftOut } = selectEvidence(mentions);
  const previous = existing?.body_md?.trim() ?? "";
  const header = `ENTITY: ${entity.canonical_name}${entity.disambiguator ? ` — ${entity.disambiguator}` : ""}\nTYPE: ${entity.type}`;

  let tokensIn = 0;
  let tokensOut = 0;
  let planBlock = "";

  if (evidence.length > PLAN_THRESHOLD) {
    const plan = await planEntry(entity, evidence);
    tokensIn += plan.usage.tokensIn;
    tokensOut += plan.usage.tokensOut;
    planBlock = plan.text;
  }

  const parts: string[] = [
    header,
    sourcesBlock(evidence),
    timelineBlock(entityId),
    relationsBlock(entityId),
  ].filter(Boolean);

  if (existing) {
    const failures = pastFailures(entityId);
    if (failures) parts.push(failures);
  }
  if (planBlock) parts.push(planBlock);

  parts.push(`EVIDENCE (${evidence.length} passages${leftOut ? `; ${leftOut} more were held back as duplicates or thin` : ""}):\n${renderEvidence(evidence)}`);

  if (previous) {
    parts.push(
      `PREVIOUS VERSION (rewrite the whole entry from the evidence above; keep what still holds, fill the changelog with what changed):\n"""\n${previous}\n"""`
    );
  } else {
    parts.push(`Write the entry. Leave changelog as an empty string.`);
  }

  const system = [
    SYSTEM_BASE,
    `LANGUAGE: write the entry in ${languageName(language)}. Quotes you reproduce stay in their original language; names keep the sources' spelling.`,
    `SHAPE. ${SHAPES[entity.type] ?? SHAPES.concept}`,
    correctionsFor(entityId),
  ]
    .filter(Boolean)
    .join("\n\n");

  const { data, usage } = await generateJson<{
    plan?: { heading: string; about?: string; mentionIds: number[] }[];
    summary: string;
    body: string;
    changelog?: string;
    contradictions?: { claimA: string; claimB: string; mentionA?: number; mentionB?: number }[];
  }>({
    stage: "entry",
    lang: language,
    sample: evidence.map((m) => m.quote).join(" ").slice(0, 600),
    system,
    schema: SCHEMA,
    parts,
    temperature: 0.25,
  });
  tokensIn += usage.tokensIn;
  tokensOut += usage.tokensOut;

  const validIds = new Set(mentions.map((m) => m.id));
  const { body, dropped } = repairBody(data.body ?? "", validIds);
  const summary = (data.summary ?? "").replace(/\s*\[\[m:\d+\]\]/g, "").trim();
  const triggerSource = evidence[evidence.length - 1]?.source_id ?? null;

  tx(() => {
    const passes = sameEvidence ? (existing?.passes ?? 0) + 1 : 1;
    const flagRewrites = sameEvidence
      ? (existing?.flag_rewrites ?? 0) + (fromFlags ? 1 : 0)
      : fromFlags
        ? 1
        : 0;

    db()
      .prepare(
        `INSERT INTO entries (entity_id, summary, body_md, built_from_hash, model, passes, flag_rewrites, lang, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(entity_id) DO UPDATE SET
           summary=excluded.summary, body_md=excluded.body_md,
           built_from_hash=excluded.built_from_hash, model=excluded.model,
           passes=excluded.passes, flag_rewrites=excluded.flag_rewrites, lang=excluded.lang,
           updated_at=datetime('now')`
      )
      .run(entityId, summary, body, hash, null, passes, flagRewrites, language);

    db()
      .prepare(
        `INSERT INTO entry_revisions (entity_id, body_md, changelog_md, trigger_source_id)
         VALUES (?, ?, ?, ?)`
      )
      .run(entityId, body, data.changelog?.trim() || null, triggerSource);

    // Contradictions are findings, and a finding recorded twice is noise. The
    // same pair from a later rewrite is skipped.
    const exists = db().prepare(
      "SELECT 1 FROM contradictions WHERE entity_id=? AND claim_a=? AND claim_b=?"
    );
    const insert = db().prepare(
      `INSERT INTO contradictions (entity_id, claim_a, claim_b, source_a, source_b, quote_a, quote_b)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const c of data.contradictions ?? []) {
      const a = c.claimA?.trim();
      const b = c.claimB?.trim();
      if (!a || !b) continue;
      if (exists.get(entityId, a, b) || exists.get(entityId, b, a)) continue;
      const ma = c.mentionA ? mentions.find((x) => x.id === c.mentionA) : undefined;
      const mb = c.mentionB ? mentions.find((x) => x.id === c.mentionB) : undefined;
      insert.run(entityId, a, b, ma?.source_id ?? null, mb?.source_id ?? null, ma?.quote ?? null, mb?.quote ?? null);
    }

    db().prepare("UPDATE entities SET entry_state='fresh' WHERE id=?").run(entityId);

    // Identity is a question about people who share a name; asking it of a
    // place or a treaty was a skipped task on every one of them. Verification
    // reads the prose last, because it judges sentences.
    enqueue(task.run_id, [
      ...(entity.type === "person" ? [{ kind: "identity" as const, payload: { entityId } }] : []),
      { kind: "verify" as const, payload: { entityId } },
    ]);

    const cited = [...citedIdsOf(body)].filter((id) => validIds.has(id)).length;
    const pct = Math.round((cited / mentions.length) * 100);
    finishTask(
      task.id,
      task.run_id,
      { tokensIn, tokensOut },
      "done",
      `${previous ? "Rewritten" : "Written"} from ${evidence.length} passages; ${cited} cited (${pct}%)` +
        (planBlock ? ", planned first" : "") +
        (dropped ? `; ${dropped} sentence(s) dropped for citing nothing that exists` : "") +
        "."
    );
  });
}

/**
 * Which passages the writer sees, when there are more than it can use.
 *
 * Richest first — a passage with a claim and a context line is worth more to a
 * writer than a bare sentence the sweep found by name — then newest, so a
 * living subject's recent evidence is never the part that gets cut.
 */
function selectEvidence(all: MentionRow[]): { evidence: MentionRow[]; leftOut: number } {
  if (all.length <= MAX_EVIDENCE) return { evidence: all, leftOut: 0 };
  const score = (m: MentionRow) =>
    (m.claim ? 2 : 0) +
    (m.context ? 2 : 0) +
    (m.attribution ? 1 : 0) +
    (m.confidence >= 1 ? 1 : 0) +
    Math.min(m.quote.length, 400) / 400;
  const ranked = [...all].sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    return (b.published_at ?? b.source_year ?? "").localeCompare(a.published_at ?? a.source_year ?? "");
  });
  const kept = new Set(ranked.slice(0, MAX_EVIDENCE).map((m) => m.id));
  // Back into reading order, so the writer sees each book in sequence.
  return { evidence: all.filter((m) => kept.has(m.id)), leftOut: all.length - kept.size };
}

/** A cheap planning call for a large subject: the gist of every passage in,
 *  a section list out. */
async function planEntry(
  entity: { canonical_name: string; type: string; disambiguator: string | null },
  evidence: MentionRow[]
): Promise<{ text: string; usage: { tokensIn: number; tokensOut: number } }> {
  const lines = evidence.map((m) => {
    const when = dateOf(m);
    const gist = (m.claim ?? m.quote).replace(/\s+/g, " ").slice(0, 160);
    const ctx = m.context ? ` — ${m.context.replace(/\s+/g, " ").slice(0, 80)}` : "";
    return `[[m:${m.id}]] ${when ? `(${when}) ` : ""}${gist}${ctx}`;
  });

  const { data, usage } = await generateJson<{
    spine: string;
    sections: { heading: string; about?: string; mentionIds: number[] }[];
    leaveOut?: number[];
  }>({
    stage: "entry",
    system: PLAN_SYSTEM,
    schema: PLAN_SCHEMA,
    temperature: 0.2,
    parts: [
      `SUBJECT: ${entity.canonical_name}${entity.disambiguator ? ` — ${entity.disambiguator}` : ""} (${entity.type})`,
      `PASSAGES:\n${lines.join("\n")}`,
    ],
  });

  const valid = new Set(evidence.map((m) => m.id));
  const sections = (data.sections ?? [])
    .map((s) => ({ ...s, mentionIds: (s.mentionIds ?? []).filter((id) => valid.has(id)) }))
    .filter((s) => s.heading?.trim());

  const text =
    sections.length === 0
      ? ""
      : `PLAN (made from all the passages; follow it, merging sections where that reads better):\nSpine: ${data.spine ?? "chronological"}\n` +
        sections
          .map(
            (s, i) =>
              `${i + 1}. ${s.heading.trim()}${s.about ? ` — ${s.about.trim()}` : ""}\n   passages: ${s.mentionIds.map((id) => `[[m:${id}]]`).join(" ") || "(none)"}`
          )
          .join("\n") +
        ((data.leaveOut ?? []).length ? `\nLeave out: ${(data.leaveOut ?? []).filter((id) => valid.has(id)).map((id) => `[[m:${id}]]`).join(" ")}` : "");

  return { text, usage };
}

/**
 * Fixes the body the model returned so that it can be trusted.
 *
 * Markers are normalised into the one grammar. A marker pointing at a passage
 * that does not exist is a fabricated source; it is removed, and a sentence
 * left with no citation *because of that removal* is removed too — the rule is
 * that an uncitable sentence is not written, and quietly keeping it uncited
 * was the way that rule used to be broken. A framing sentence that never had a
 * marker is left alone; the verifier judges those against their paragraph.
 */
export function repairBody(raw: string, validIds: Set<number>): { body: string; dropped: number } {
  const SENTINEL = "\u2063DEAD\u2063";
  let dropped = 0;

  const marked = normaliseMarkers(raw).replace(/[ \t]*\[\[m:(\d+)\]\]/g, (whole, id) =>
    validIds.has(Number(id)) ? whole : SENTINEL
  );
  if (!marked.includes(SENTINEL)) return { body: marked, dropped: 0 };
  const tidy = (s: string) => s.split(SENTINEL).join("").replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ");

  const out = marked
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((para) => {
      if (!para.includes(SENTINEL)) return para;
      if (/^#{1,6}\s/.test(para.trim())) return tidy(para);
      const prefix = /^(\s*(?:[-*•]|\d+[.)]|>)\s+)/.exec(para)?.[1] ?? "";
      const flat = para.slice(prefix.length).replace(/\n/g, " ");
      const kept = paragraphSentences(flat)
        .map((s) => s.text)
        .filter((s) => {
          if (!s.includes(SENTINEL)) return true;
          if (/\[\[m:\d+\]\]/.test(s)) return true;
          dropped++;
          return false;
        })
        .map((s) => tidy(s).trim())
        .filter(Boolean);
      return kept.length ? prefix + kept.join(" ") : "";
    })
    .filter((p) => p.trim())
    .join("\n\n");

  return { body: out, dropped };
}

export function mentionsFor(entityId: number): MentionRow[] {
  const rows = db()
    .prepare(
      `SELECT m.id, m.quote, m.claim, m.context, m.confidence, m.surface, m.source_id,
              m.attribution, m.claim_kind,
              s.title AS source_title, s.author AS source_author, s.lang AS source_lang,
              s.year AS source_year, s.kind AS source_kind, s.outlet AS source_outlet,
              s.published_at,
              c.locator_json, d.label AS doc_label
         FROM live_mentions m
         JOIN sources s ON s.id = m.source_id
         JOIN chunks  c ON c.id = m.chunk_id
    LEFT JOIN documents d ON d.id = c.doc_id
        WHERE m.entity_id = ?
        ORDER BY COALESCE(s.published_at, s.year, ''), m.source_id, m.id`
    )
    .all(entityId) as MentionRow[];

  // Deduplicated here rather than at the point of insertion, because that fixes
  // the entries as well as the extraction: a library already holding repeats
  // stops citing them the next time it is written, without a migration.
  return dedupeByQuote(rows);
}

/** "book", "article", "recording": what the writer is told a source is. */
function kindLabel(kind: string | null): string {
  switch (kind) {
    case "pdf":
    case "epub":
      return "book";
    case "url":
      return "article";
    case "media":
      return "recording";
    case "text":
      return "text";
    default:
      return kind ?? "source";
  }
}

function dateOf(m: MentionRow): string {
  return (m.published_at ?? "").slice(0, 10) || m.source_year || "";
}

/**
 * The works this entity is being written from, with what kind of thing each
 * is and when it appeared. "Saudi, Inc." and a wire report from last Tuesday
 * are not the same kind of witness, and the entry should know which it is
 * leaning on.
 */
function sourcesBlock(rows: MentionRow[]): string {
  const seen = new Map<number, MentionRow>();
  for (const r of rows) if (!seen.has(r.source_id)) seen.set(r.source_id, r);

  const lines = [...seen.values()].map((r) => {
    const who = [r.source_author, r.source_outlet].filter(Boolean).join(", ");
    const when = dateOf(r);
    const count = rows.filter((x) => x.source_id === r.source_id).length;
    return `- "${r.source_title}" (${kindLabel(r.source_kind)}${who ? `; ${who}` : ""}${when ? `; ${when}` : ""}) — ${count} passage${count === 1 ? "" : "s"}`;
  });

  return `THE WORKS THIS EVIDENCE COMES FROM:\n${lines.join("\n")}${
    seen.size > 1
      ? `\n\nThese are different accounts by different authors. Where they diverge, name the
work rather than averaging them. Prefer the more recent account for what is
current and the fuller account for what happened.`
      : `\n\nEverything below comes from this single work. The entry records what this one
account says, not what is established — say so where it matters.`
  }`;
}

/**
 * The dated events extraction recorded for this entity, oldest first. The
 * writer used to reconstruct chronology from loose quotes, which is why entries
 * had no chronology; this hands it the spine ready-made.
 */
function timelineBlock(entityId: number): string {
  const rows = db()
    .prepare(
      `SELECT ev.date_iso, ev.date_text, ev.summary, ev.mention_id
         FROM events ev
         JOIN live_mentions m ON m.id = ev.mention_id
        WHERE ev.entity_id = ?
        ORDER BY COALESCE(ev.date_iso, 'zzzz'), ev.id
        LIMIT 40`
    )
    .all(entityId) as { date_iso: string | null; date_text: string | null; summary: string; mention_id: number | null }[];
  if (rows.length === 0) return "";
  return `DATED EVENTS (as recorded from the passages; cite the passage, not this list):\n${rows
    .map((r) => `- ${r.date_iso ?? r.date_text ?? "undated"}: ${r.summary}${r.mention_id ? ` [[m:${r.mention_id}]]` : ""}`)
    .join("\n")}`;
}

/** Recorded relationships, so "his brother" can be named and a paragraph on a
 *  patron or rival has somewhere to start. */
function relationsBlock(entityId: number): string {
  const rows = db()
    .prepare(
      `SELECT r.type, r.mention_id,
              CASE WHEN r.from_entity=? THEN 'out' ELSE 'in' END AS direction,
              other.canonical_name AS other_name, other.type AS other_type
         FROM relations r
         JOIN entities other
           ON other.id = CASE WHEN r.from_entity=? THEN r.to_entity ELSE r.from_entity END
        WHERE (r.from_entity=? OR r.to_entity=?) AND other.merged_into IS NULL
        ORDER BY r.id
        LIMIT 30`
    )
    .all(entityId, entityId, entityId, entityId) as {
    type: string;
    mention_id: number | null;
    direction: "in" | "out";
    other_name: string;
    other_type: string;
  }[];
  if (rows.length === 0) return "";
  return `RECORDED RELATIONS (cite the passage, not this list):\n${rows
    .map((r) =>
      r.direction === "out"
        ? `- ${r.type} → ${r.other_name} (${r.other_type})${r.mention_id ? ` [[m:${r.mention_id}]]` : ""}`
        : `- ${r.other_name} (${r.other_type}) ${r.type} → this subject${r.mention_id ? ` [[m:${r.mention_id}]]` : ""}`
    )
    .join("\n")}`;
}

/** Above this the block stops being instructions and becomes a second entry. */
const MAX_FAILURES_SHOWN = 15;

/**
 * What verification found wrong with the entry being replaced.
 *
 * The verify pass reads each cited sentence against its own quotes and flags
 * the ones the quotes do not carry — sentences that are usually true in the
 * world and absent from the evidence, wearing citation markers that point at
 * passages about something else. The verdicts ride along, sentence by
 * sentence, and the instruction is to investigate, not to obey: a flag can be
 * wrong, and the evidence is in front of the writer to check.
 *
 * Queried from entry_flags directly rather than through lib/pipeline/verify,
 * which imports helpers from this module — the other direction would be a cycle.
 */
export function pastFailures(entityId: number): string {
  const flags = db()
    .prepare(
      "SELECT sentence, verdict, note, mention_ids FROM entry_flags WHERE entity_id=? ORDER BY id"
    )
    .all(entityId) as {
    sentence: string;
    verdict: string;
    note: string | null;
    mention_ids: string;
  }[];
  if (flags.length === 0) return "";

  const lines = flags.slice(0, MAX_FAILURES_SHOWN).map((f) => {
    const note = f.note?.trim() ? `\n  What the cited passages actually say: ${f.note.trim()}` : "";
    return `- [${f.verdict}] "${f.sentence.trim()}"${note}`;
  });
  const held = flags.length - Math.min(flags.length, MAX_FAILURES_SHOWN);

  return `FAILED VERIFICATION. The previous version of this entry was read back
sentence by sentence against the passages it cited, and these sentences were not
borne out by their own citations:

${lines.join("\n")}${held > 0 ? `\n(and ${held} more like these)` : ""}

Investigate each one against the evidence in front of you:
- If the evidence genuinely supports the claim, keep it — cited to the passages
  that actually say it, which may not be the markers it was wearing.
- If the evidence supports something weaker or narrower, write the weaker thing.
- If nothing in the evidence says it, leave it out entirely, however true you
  know it to be.
Do not repeat a flagged sentence with its old citations unexamined.`;
}

/**
 * The evidence, as the writer sees it. Dated, attributed, and glossed.
 */
function renderEvidence(rows: MentionRow[]): string {
  return rows
    .map((m) => {
      const loc = formatLocator(JSON.parse(m.locator_json), m.doc_label);
      const when = dateOf(m);
      const where = [m.source_title, when, loc].filter(Boolean).join(", ");
      const lines = [`[[m:${m.id}]] (${where})`, `   "${m.quote}"`];
      if (m.claim) lines.push(`   claim: ${m.claim}`);
      if (m.context) lines.push(`   in context: ${m.context}`);
      if (m.attribution && m.attribution !== "source") lines.push(`   attributed to: ${m.attribution}`);
      if (m.claim_kind && m.claim_kind !== "fact") lines.push(`   kind: ${m.claim_kind}`);
      if (isFromContext(m.confidence)) {
        lines.push(`   note: the passage does not name the subject; identified from surrounding text`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export function citedIds(body: string): Set<number> {
  return citedIdsOf(body);
}

/**
 * What share of an entity's evidence its entry actually cites. Reported, not
 * enforced — see lib/entries.ts for why.
 */
export function coverageOf(entityId: number): { cited: number; total: number; ratio: number } {
  const mentions = mentionsFor(entityId);
  const total = mentions.length;
  const row = db().prepare("SELECT body_md FROM entries WHERE entity_id=?").get(entityId) as
    | { body_md: string }
    | undefined;
  if (!row || total === 0) return { cited: 0, total, ratio: total === 0 ? 1 : 0 };

  const valid = new Set(mentions.map((m) => m.id));
  const cited = [...citedIdsOf(row.body_md)].filter((id) => valid.has(id)).length;
  return { cited, total, ratio: cited / total };
}

export function hashOf(ids: number[]): string {
  return crypto.createHash("sha1").update(ids.slice().sort((a, b) => a - b).join(",")).digest("hex");
}

/** Recomputes staleness for one entity against its current evidence. */
export function refreshState(entityId: number) {
  const ids = (
    db().prepare("SELECT id FROM live_mentions WHERE entity_id=?").all(entityId) as { id: number }[]
  ).map((r) => r.id);
  const entry = db()
    .prepare("SELECT built_from_hash FROM entries WHERE entity_id=?")
    .get(entityId) as { built_from_hash: string } | undefined;
  const state = !entry ? "none" : entry.built_from_hash === hashOf(ids) ? "fresh" : "stale";
  db().prepare("UPDATE entities SET entry_state=? WHERE id=?").run(state, entityId);
}
