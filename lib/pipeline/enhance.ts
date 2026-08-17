import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { finishTask } from "../queue";
import type { ChunkExtraction, Task } from "../types";
import { formatLocator } from "../chunk";
import { SCHEMA, SYSTEM, persist, precedingText, quoteKey } from "./extract";

/**
 * A second look at a passage that has already been read.
 *
 * "Read again" throws the source's extraction away and rebuilds it, which is
 * right when the first pass was wrong and expensive and destructive when it was
 * merely thin. Most of the time the first pass was neither: it was correct as
 * far as it went and simply did not go far enough — it caught the four people
 * the paragraph is about and missed the treaty they signed.
 *
 * So Enhance is strictly additive. The model is shown the passage *and*
 * everything already on record from it, and asked for what is missing. Nothing
 * existing is deleted, no entry loses its citations, and a second Enhance on an
 * exhausted passage costs one call and writes nothing.
 */

const ENHANCE_SYSTEM = `${SYSTEM}

THIS IS A SECOND PASS.

You will be given ALREADY RECORDED: everything a previous reading of this same
passage extracted. Your job is only what it missed.

- Do not repeat anything in ALREADY RECORDED. A near-duplicate with a slightly
  different quote is a repeat.
- Look hardest at what a first reading typically skips: minor figures named once,
  organisations mentioned in passing, dates attached to events, works and
  documents referred to by title, places that are more than scenery, and
  relations between two entities that were each recorded on their own but never
  connected to each other.
- Also add a back-reference resolution for anything ALREADY RECORDED left
  unresolved, by extracting that entity again ONLY IF you can now fill "context"
  with what it points at. Otherwise leave it alone.
- Finding nothing is a perfectly good answer. Return empty arrays. Do not pad,
  and do not lower the bar for what counts as an entity in order to have
  something to say. A wrong addition costs more than a missed one.`;

export async function handleEnhance(task: Task): Promise<void> {
  const { chunkId } = JSON.parse(task.payload_json) as { chunkId: number };

  const chunk = db()
    .prepare(
      `SELECT c.id, c.source_id, c.seq, c.text, c.locator_json, c.extracted_at,
              s.title AS source_title, s.lang AS source_lang, d.label AS doc_label
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
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Passage no longer exists.");
    return;
  }

  // A passage never read in the first place should be read, not enhanced — and
  // the ordinary extract task is cheaper and better at it.
  if (!chunk.extracted_at) {
    finishTask(
      task.id,
      task.run_id,
      { tokensIn: 0, tokensOut: 0 },
      "skipped",
      "Not read yet; ordinary extraction will cover it."
    );
    return;
  }

  const existing = db()
    .prepare(
      `SELECT m.id, m.surface, m.quote, m.claim, m.context, e.canonical_name, e.type
         FROM mentions m JOIN entities e ON e.id = m.entity_id
        WHERE m.chunk_id = ? ORDER BY m.id`
    )
    .all(chunk.id) as {
    id: number;
    surface: string;
    quote: string;
    claim: string | null;
    context: string | null;
    canonical_name: string;
    type: string;
  }[];

  const relations = db()
    .prepare(
      `SELECT r.type, a.canonical_name AS from_name, b.canonical_name AS to_name
         FROM relations r
         JOIN mentions m ON m.id = r.mention_id
         JOIN entities a ON a.id = r.from_entity
         JOIN entities b ON b.id = r.to_entity
        WHERE m.chunk_id = ?`
    )
    .all(chunk.id) as { type: string; from_name: string; to_name: string }[];

  const where = formatLocator(JSON.parse(chunk.locator_json), chunk.doc_label);
  const earlier = precedingText(chunk.source_id, chunk.seq);

  const { data, usage } = await generateJson<ChunkExtraction>({
    stage: "extract",
    lang: chunk.source_lang ?? undefined,
    sample: chunk.text.slice(0, 600),
    system: ENHANCE_SYSTEM,
    schema: SCHEMA,
    parts: [
      [
        `Source: ${chunk.source_title}${where ? ` — ${where}` : ""}`,
        earlier
          ? `\nEARLIER TEXT (context only — do not extract or quote from this):\n"""\n${earlier}\n"""`
          : "",
        `\nPASSAGE:\n"""\n${chunk.text}\n"""`,
        `\nALREADY RECORDED from this passage — do not repeat any of it:\n${describe(existing, relations)}`,
      ].join("\n"),
    ],
  });

  // The prompt asks for novelty; this enforces it. A model told not to repeat
  // itself will still sometimes re-file the same quote under a tidier name.
  const seen = new Set(existing.map((m) => quoteKey(m.surface, m.quote)));

  tx(() => {
    const added = persist(chunk, data, seen);
    finishTask(
      task.id,
      task.run_id,
      usage,
      "done",
      added.mentions || added.relations || added.events
        ? `Found ${added.mentions} more quote(s), ${added.relations} relation(s), ${added.events} event(s).`
        : "Nothing further in this passage."
    );
  });
}

function describe(
  mentions: { surface: string; quote: string; claim: string | null; context: string | null; canonical_name: string; type: string }[],
  relations: { type: string; from_name: string; to_name: string }[]
): string {
  if (mentions.length === 0 && relations.length === 0) {
    return "(nothing — the previous reading found nothing here)";
  }

  const lines = mentions.map((m) => {
    const bits = [`- ${m.canonical_name} (${m.type}), as "${m.surface}": "${trim(m.quote)}"`];
    if (m.context) bits.push(`  refers to: ${trim(m.context, 120)}`);
    return bits.join("\n");
  });

  if (relations.length) {
    lines.push(
      "",
      "Relations already recorded:",
      ...relations.map((r) => `- ${r.from_name} — ${r.type} — ${r.to_name}`)
    );
  }
  return lines.join("\n");
}

function trim(s: string, n = 200): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
