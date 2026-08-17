import crypto from "node:crypto";
import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { enqueue, finishTask } from "../queue";
import { correctionsFor } from "../audit";
import { dedupeByQuote, isFromContext, type Task } from "../types";
import { formatLocator } from "../chunk";

/**
 * An entry is never authored once and left alone — it is a function of the
 * evidence, and the evidence grows. `built_from_hash` records exactly which
 * mentions produced the current text; when that set changes the entity goes
 * stale and this runs again.
 *
 * The second run is a revision, not a rewrite: the model sees the existing
 * entry plus only the mentions it has not seen before, and reports what
 * changed. That is cheaper than re-reading everything, and it produces the
 * thing a researcher actually wants — a record of how the picture shifted when
 * a new book came in.
 */

interface MentionRow {
  id: number;
  quote: string;
  claim: string | null;
  context: string | null;
  confidence: number;
  surface: string;
  source_id: number;
  source_title: string;
  source_author: string | null;
  source_lang: string | null;
  source_year: string | null;
  source_kind: string | null;
  locator_json: string;
  doc_label: string | null;
}

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: "One or two sentences identifying who or what this is. No citations.",
    },
    body: {
      type: Type.STRING,
      description:
        "The encyclopedia entry in Markdown. Every factual sentence ends with one or more citation markers of the form [[m:ID]].",
    },
    changelog: {
      type: Type.STRING,
      description:
        "Markdown bullets naming what the new evidence added, corrected, or complicated. Empty string on a first draft.",
    },
    contradictions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          claimA: { type: Type.STRING, description: "What the existing entry held." },
          claimB: { type: Type.STRING, description: "What the new evidence asserts." },
          mentionB: { type: Type.INTEGER, description: "Mention ID supporting claim B." },
        },
        required: ["claimA", "claimB"],
      },
    },
  },
  required: ["summary", "body"],
};

const SYSTEM = `You write encyclopedia entries for a researcher's private reference work,
built strictly from the passages they have collected.

Absolute rules:
- Every factual sentence must end with at least one citation marker: [[m:ID]],
  using the mention IDs given to you. A sentence you cannot cite is a sentence you
  must not write.
- Use only the evidence supplied. You certainly know things about these subjects
  from your training; leaving them out is the entire point. This entry documents
  what THESE SOURCES say, and a researcher will cite it as such.
- Write in the language the evidence is written in. If the evidence is Arabic,
  write the entry in Arabic.
- Where sources disagree, say so in the entry and report the disagreement in the
  contradictions array. Do not silently pick a winner.
- Attribute contested claims to the source that makes them ("According to
  Heikal, …") rather than stating them flatly.
- No invented dates, titles, or relationships. Uncertainty stated plainly is
  worth more than confident filler.
- NAME PEOPLE IN FULL THE FIRST TIME. The first appearance of any person —
  including the subject of this entry — gives the fullest form the evidence
  supports: "Crown Prince Feisal bin Abdulaziz", not "Feisal"; "Steve Bechtel",
  not "Bechtel". Short forms are correct everywhere after that.
  This is not a style preference. These sources are full of families who share
  a name: several Abdulazizes, several Feisals, a Bechtel who is a man and a
  Bechtel that is a company. An entry opening with a bare given name or a bare
  surname cannot be read without already knowing which one is meant, which is
  the knowledge the entry exists to supply. Where two people in this entry could
  be confused, keep distinguishing them after the first mention too.
- An "in context" line under a quote says what that passage is talking about —
  the episode, the moment, the person — recovered by whoever read the pages
  around it. Use it: write "following the 2015 Mina stampede" rather than
  copying the source's "following one incident", and "when Thomas Barger took a
  mining job in the early 1930s" rather than "during one period". The citation
  still belongs to the quote; the context tells you what the quote is *of*.
  Where a quote has no "in context" line and turns on something vague, say so
  plainly rather than filling the gap — or leave it out, per the rule above.
- A "note" line marking a mention as identified from surrounding text means the
  passage never named the subject. Such evidence is usable but weaker; do not
  build a central claim on it alone.
- A claim you cannot situate is worth less than no claim. Where a quote's sense
  depends on surroundings you were not given — it turns on "one incident", "that
  period", "the agreement" — and no "refers to" line supplies them, leave it out
  rather than write a sentence whose whole content is that something happened at
  some unspecified time. "During one domestic period, unemployment reached 14
  percent" is not a fact about a country; it is a fact about a missing sentence.
  You are not scored on how much of the evidence you use. An entry that uses
  nine passages well is worth more than one that uses twelve and says nothing
  with three of them.
- Do not open with a definition the evidence does not contain. If the passages
  never say what this thing *is*, the entry does not get to say either — begin
  with what they do establish. Stating the obvious from your own knowledge and
  hanging the nearest citation off it is the exact failure this format exists to
  prevent, and it is invisible to a reader, who sees only a cited sentence.

Structure the body with short Markdown sections when there is enough material —
typically an opening paragraph, then themes. Keep it dense; skip filler prose.

Formatting, which matters because this is rendered rather than read raw:
- A heading goes on a line of its own, with a blank line before it and a blank
  line after it. Never put a "##" marker in the middle of a line of prose.
- Separate paragraphs with a blank line.

Correct:

## Oil policy

Feisal led the negotiating teams on profit-sharing [[m:12]].

Wrong — a marker buried in a sentence, which cannot be rendered:

...prioritized Wahhabi Islam [[m:7]]. ## Oil policy Feisal led the teams [[m:12]].`;

/**
 * How much evidence one call may be given.
 *
 * The US entry had 146 quotes behind it and cited 52 of them — 36%. Entities
 * with a dozen quotes were at 100%. The difference is not judgement, it is
 * room: asked to turn 146 passages into one entry in a single response, a model
 * compresses, and what it compresses away is most of the evidence. Nothing then
 * revisited it, because `built_from_hash` recorded all 146 as accounted for.
 *
 * So a large entity is written over several passes instead, each one folding in
 * a batch of the evidence the entry does not yet cite.
 */
const EVIDENCE_PER_PASS = 40;

/** A ceiling, so a model that refuses to cite anything cannot loop for ever. */
const MAX_PASSES = 8;

/** Below this share of evidence cited, the entry is treated as unfinished. */
export const COVERAGE_TARGET = 0.85;

export async function handleEntry(task: Task): Promise<void> {
  const { entityId, force, pass = 0 } = JSON.parse(task.payload_json) as {
    entityId: number;
    /** Set when you asked for this by hand, which overrides "already current". */
    force?: boolean;
    /** Which completion pass this is. Passes after the first fold in the
     *  evidence the entry does not yet cite. */
    pass?: number;
  };

  const entity = db()
    .prepare("SELECT * FROM entities WHERE id=? AND merged_into IS NULL")
    .get(entityId) as
    | { id: number; canonical_name: string; type: string; disambiguator: string | null; entry_state: string }
    | undefined;

  if (!entity) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Entity was merged away.");
    return;
  }

  const mentions = mentionsFor(entityId);
  if (mentions.length === 0) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "No evidence.");
    return;
  }

  const hash = hashOf(mentions.map((m) => m.id));
  const existing = db()
    .prepare("SELECT * FROM entries WHERE entity_id=?")
    .get(entityId) as
    | { entity_id: number; summary: string; body_md: string; built_from_hash: string }
    | undefined;

  // A forced rewrite starts from a blank page, but only on its first pass —
  // the passes that follow have to build on what the first one wrote.
  const startClean = Boolean(force) && pass === 0;
  const baseBody = startClean ? "" : (existing?.body_md ?? "");

  const covered = new Set(citedIds(baseBody));
  const uncovered = mentions.filter((m) => !covered.has(m.id));

  // Nothing new to say, and nothing left out — unless you asked for a rewrite,
  // in which case the point is usually that you did not like the last one.
  if (!force && existing?.built_from_hash === hash && uncovered.length === 0) {
    tx(() => {
      db().prepare("UPDATE entities SET entry_state='fresh' WHERE id=?").run(entityId);
      finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Already current.");
    });
    return;
  }

  // One batch of what the entry does not yet account for. If the previous body
  // cited nothing we can trust, fall back to the start of the full set.
  const pool = uncovered.length ? uncovered : mentions;
  const evidence = pool.slice(0, EVIDENCE_PER_PASS);
  const isRevision = Boolean(baseBody);
  const triggerSource = evidence[evidence.length - 1]?.source_id ?? null;

  const header = `ENTITY: ${entity.canonical_name}${entity.disambiguator ? ` — ${entity.disambiguator}` : ""}\nTYPE: ${entity.type}`;

  const remainder = pool.length - evidence.length;
  const more = remainder > 0
    ? `\n\nThere are ${remainder} further passages still to come in a later pass. Do not try to
summarise them now and do not leave room for them — just account fully for the
evidence in front of you.`
    : "";

  const parts: string[] = [header, sourcesBlock(mentions)];

  // What verification found wrong with the version being replaced. Only on the
  // first pass: the flags describe the *stored* entry, and by pass two that
  // entry no longer exists — handing its faults to a completion pass would be
  // asking it to fix sentences that are already gone.
  if (pass === 0 && existing) {
    const failures = pastFailures(entityId);
    if (failures) parts.push(failures);
  }

  if (isRevision) {
    parts.push(
      `EXISTING ENTRY (revise it; keep citation markers that still hold):\n"""\n${baseBody}\n"""`,
      `EVIDENCE the entry does not yet account for:\n${renderEvidence(evidence)}`,
      `Fold every one of these passages into the entry. Preserve existing text and its
[[m:ID]] markers wherever the new evidence does not change it. Fill the changelog
with what actually changed.${more}`
    );
  } else {
    parts.push(
      `EVIDENCE:\n${renderEvidence(evidence)}`,
      `Write the entry. Leave changelog as an empty string.${more}`
    );
  }

  const { data, usage } = await generateJson<{
    summary: string;
    body: string;
    changelog?: string;
    contradictions?: { claimA: string; claimB: string; mentionB?: number }[];
  }>({
    stage: "entry",
    lang: evidence[0]?.source_lang ?? undefined,
    sample: evidence.map((m) => m.quote).join(" ").slice(0, 600),
    // Evidence you have rejected for this subject is already gone from what
    // follows — that part is enforced, not asked for. This tells the writer why
    // it went, which is the only way the next draft avoids the same reading.
    system: [SYSTEM, correctionsFor(entityId)].filter(Boolean).join("\n\n"),
    schema: SCHEMA,
    parts,
    temperature: 0.25,
  });

  const validIds = new Set(mentions.map((m) => m.id));
  // Strip citations pointing at mentions that don't exist. A dead marker is a
  // fabricated source, which is exactly what this tool exists to prevent.
  const body = data.body.replace(/\[\[m:(\d+)\]\]/g, (whole, id) =>
    validIds.has(Number(id)) ? whole : ""
  );

  tx(() => {
    db()
      .prepare(
        `INSERT INTO entries (entity_id, summary, body_md, built_from_hash, model, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(entity_id) DO UPDATE SET
           summary=excluded.summary, body_md=excluded.body_md,
           built_from_hash=excluded.built_from_hash, model=excluded.model,
           updated_at=datetime('now')`
      )
      .run(entityId, data.summary ?? "", body, hash, null);

    db()
      .prepare(
        `INSERT INTO entry_revisions (entity_id, body_md, changelog_md, trigger_source_id)
         VALUES (?, ?, ?, ?)`
      )
      .run(entityId, body, data.changelog?.trim() || null, triggerSource);

    for (const c of data.contradictions ?? []) {
      if (!c.claimA?.trim() || !c.claimB?.trim()) continue;
      const m = c.mentionB ? mentions.find((x) => x.id === c.mentionB) : undefined;
      db()
        .prepare(
          `INSERT INTO contradictions (entity_id, claim_a, claim_b, source_b, quote_b)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(entityId, c.claimA.trim(), c.claimB.trim(), m?.source_id ?? null, m?.quote ?? null);
    }

    db().prepare("UPDATE entities SET entry_state='fresh' WHERE id=?").run(entityId);

    // Did this pass actually account for its batch?
    const nowCovered = citedIds(body);
    const stillUncovered = mentions.filter((m) => !nowCovered.has(m.id)).length;
    const gained = nowCovered.size - covered.size;

    // Another pass is worth it only if there is something left AND this pass
    // made progress. Without the second condition, a model that declines to
    // cite anything would be asked the same question eight times.
    const unfinished = stillUncovered > 0 && pass + 1 < MAX_PASSES && gained > 0;

    if (unfinished) {
      enqueue(task.run_id, [
        { kind: "entry" as const, payload: { entityId, pass: pass + 1 } },
      ]);
    } else {
      // The final checks, in the only order that makes sense: whether the
      // evidence is about one person before whether the prose about it hangs
      // together. Asking the second question first would tidy an entry that is
      // then split in half, and the tidying would be thrown away. Verification
      // comes last of all, because it judges sentences and there is no point
      // judging sentences that coherence is about to rewrite.
      enqueue(task.run_id, [
        { kind: "identity" as const, payload: { entityId } },
        { kind: "coherence" as const, payload: { entityId } },
        { kind: "verify" as const, payload: { entityId } },
      ]);
    }

    const pct = Math.round((nowCovered.size / mentions.length) * 100);
    finishTask(
      task.id,
      task.run_id,
      usage,
      "done",
      `Pass ${pass + 1}: ${nowCovered.size} of ${mentions.length} passages cited (${pct}%)` +
        (unfinished ? `; ${stillUncovered} still to fold in.` : ".")
    );
  });
}

export function mentionsFor(entityId: number): MentionRow[] {
  const rows = db()
    .prepare(
      `SELECT m.id, m.quote, m.claim, m.context, m.confidence, m.surface, m.source_id,
              s.title AS source_title, s.author AS source_author, s.lang AS source_lang,
              s.year AS source_year, s.kind AS source_kind,
              c.locator_json, d.label AS doc_label
         FROM live_mentions m
         JOIN sources s ON s.id = m.source_id
         JOIN chunks  c ON c.id = m.chunk_id
    LEFT JOIN documents d ON d.id = c.doc_id
        WHERE m.entity_id = ?
        ORDER BY m.source_id, m.id`
    )
    .all(entityId) as MentionRow[];

  // Deduplicated here rather than at the point of insertion, because that fixes
  // the entries as well as the extraction: a library already holding repeats
  // stops citing them the next time it is written, without a migration.
  return dedupeByQuote(rows);
}

/**
 * The books this entity is being written from.
 *
 * The writer was previously handed loose passages with a title beside each one
 * and no idea what any of the titles were. That is a real handicap: "Saudi,
 * Inc." and "The Hundred Years' War on Palestine" are not neutral observers of
 * the same events, and a passage means something different depending on whose
 * account it is. Naming the works up front — with author, year and kind — lets
 * the entry attribute a contested claim to a book rather than to the void, and
 * is roughly forty tokens.
 */
function sourcesBlock(rows: MentionRow[]): string {
  const seen = new Map<number, MentionRow>();
  for (const r of rows) if (!seen.has(r.source_id)) seen.set(r.source_id, r);

  const lines = [...seen.values()].map((r) => {
    const bits = [r.source_author, r.source_year].filter(Boolean).join(", ");
    const kind = r.source_kind && r.source_kind !== "book" ? ` [${r.source_kind}]` : "";
    const count = rows.filter((x) => x.source_id === r.source_id).length;
    return `- "${r.source_title}"${bits ? ` — ${bits}` : ""}${kind} (${count} passage${count === 1 ? "" : "s"})`;
  });

  return `THE WORKS THIS EVIDENCE COMES FROM:\n${lines.join("\n")}${
    seen.size > 1
      ? `\n\nThese are different accounts by different authors. Where they diverge, name the
work rather than averaging them.`
      : `\n\nEverything below comes from this single work. The entry records what this one
account says, not what is established — say so where it matters.`
  }`;
}

/** Above this the block stops being instructions and becomes a second entry. */
const MAX_FAILURES_SHOWN = 15;

/**
 * What verification found wrong with the entry being replaced.
 *
 * The verify pass reads each cited sentence against its own quotes and flags
 * the ones the quotes do not carry — sentences that are usually true in the
 * world and absent from the evidence, wearing citation markers that point at
 * passages about something else. Regenerating used to hand the writer the same
 * evidence with no memory of those verdicts, so the same fluent sentence came
 * back wearing the same wrong markers.
 *
 * So the verdicts ride along, sentence by sentence, with the verifier's note on
 * what the cited passages actually say — and the instruction is to investigate,
 * not to obey: a flag can be wrong, and the evidence is in front of the writer
 * to check. What is forbidden is only repeating the claim unexamined.
 *
 * Queried from entry_flags directly rather than through lib/pipeline/verify,
 * which imports its sentence-splitting helpers from this module — the other
 * direction would be a cycle.
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
    // The markers stay in the sentence: they are the point — they name the
    // exact passages that were wearing a claim they do not carry.
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
  "Could" does not become "did"; one man's job does not become a national fact.
- If nothing in the evidence says it, leave it out entirely, however true you
  know it to be. Its truth came from outside these sources, and that is the one
  thing this entry must not contain.
Do not repeat a flagged sentence with its old citations unexamined.`;
}

/**
 * The evidence, as the writer sees it.
 *
 * `refers to` is what makes a back-referring quote usable. Without it the
 * writer receives "Following one incident for which Iran blamed Saudi Arabia…"
 * with no way to know which incident, and can only either repeat the vagueness
 * or invent a referent. With it, the entry can name the thing and stay cited.
 */
function renderEvidence(rows: MentionRow[]): string {
  return rows
    .map((m) => {
      const loc = formatLocator(JSON.parse(m.locator_json), m.doc_label);
      const where = [m.source_title, loc].filter(Boolean).join(", ");
      const lines = [`[[m:${m.id}]] (${where})`, `   "${m.quote}"`];
      if (m.claim) lines.push(`   claim: ${m.claim}`);
      if (m.context) lines.push(`   in context: ${m.context}`);
      // Only when the name really was recovered from the surroundings. Testing
      // `confidence < 1` here swept in every passage the name-matching sweep
      // found — passages that contain the name by construction — and told the
      // writer the opposite of the truth about 12% of the whole library.
      if (isFromContext(m.confidence)) {
        lines.push(`   note: the passage does not name the subject; identified from surrounding text`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export function citedIds(body: string): Set<number> {
  return new Set([...body.matchAll(/\[\[m:(\d+)\]\]/g)].map((m) => Number(m[1])));
}

/**
 * What share of an entity's evidence its entry actually cites.
 *
 * Worth measuring rather than assuming: an entry can be well written, properly
 * cited, and still be built from a third of what is known — which looks like a
 * good entry and is a bad record.
 */
export function coverageOf(entityId: number): { cited: number; total: number; ratio: number } {
  // Counted over the same deduplicated set the writer was given. Counting raw
  // rows here while handing the writer one copy of each would make full
  // coverage arithmetically unreachable, and the entry would be rewritten pass
  // after pass chasing passages it had already used.
  const mentions = mentionsFor(entityId);
  const total = mentions.length;
  const row = db().prepare("SELECT body_md FROM entries WHERE entity_id=?").get(entityId) as
    | { body_md: string }
    | undefined;
  if (!row || total === 0) return { cited: 0, total, ratio: total === 0 ? 1 : 0 };

  const valid = new Set(mentions.map((m) => m.id));
  const cited = [...citedIds(row.body_md)].filter((id) => valid.has(id)).length;
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
