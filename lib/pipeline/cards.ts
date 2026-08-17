import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { finishTask } from "../queue";
import { formatLocator } from "../chunk";
import type { Locator } from "../types";
import type { Task } from "../types";

/**
 * Study material, made from evidence rather than from the model's memory.
 *
 * Every card carries the mention it came from, so a card you disagree with can
 * be checked against the passage that produced it in one click. A flashcard
 * that cannot be traced is just a claim, and this whole app exists to avoid
 * those.
 */

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    cards: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          kind: { type: Type.STRING, enum: ["card", "quiz"] },
          front: { type: Type.STRING, description: "The question, or the prompt side." },
          back: { type: Type.STRING, description: "The answer. Short — a phrase or a sentence." },
          distractors: {
            type: Type.ARRAY,
            description: "For quiz cards only: three plausible wrong answers.",
            items: { type: Type.STRING },
          },
          mentionId: {
            type: Type.INTEGER,
            description: "Which supplied passage this card was built from.",
          },
        },
        required: ["kind", "front", "back", "mentionId"],
      },
    },
  },
  required: ["cards"],
};

const SYSTEM = `You make study material from a researcher's own sources.

Rules:
- Build every card from the passages given. Nothing from your own knowledge —
  the point is to study what THESE sources say.
- The front is a real question, not a fill-in-the-blank of the quote. "Which
  agency did X run in 1962?" beats "X ran the ___ in 1962".
- The back is short: a name, a date, a phrase, one sentence at most.
- For quiz cards, the three wrong answers must be plausible and of the same
  kind as the right one — other people for a person, other years for a year.
  A wrong answer that is obviously absurd teaches nothing.
- Test what matters: who did what, when, to whom, and why it mattered. Skip
  trivia that happens to appear in a sentence.
- Write in the language of the passage.
- Give each card the mentionId of the passage it came from.`;

export async function handleCards(task: Task): Promise<void> {
  const { entityId, tagId, limit } = JSON.parse(task.payload_json) as {
    entityId?: number;
    tagId?: number;
    limit?: number;
  };

  const rows = db()
    .prepare(
      `SELECT m.id, m.quote, m.claim, e.id AS entity_id, e.canonical_name AS entity,
              s.id AS source_id, s.title AS source,
              c.locator_json, d.label AS doc_label
         FROM live_mentions m
         JOIN entities e ON e.id = m.entity_id
         JOIN sources  s ON s.id = m.source_id
         JOIN chunks   c ON c.id = m.chunk_id
    LEFT JOIN documents d ON d.id = c.doc_id
        WHERE e.merged_into IS NULL
          AND m.claim IS NOT NULL
          ${entityId ? "AND e.id = @entityId" : ""}
          ${tagId ? "AND EXISTS (SELECT 1 FROM source_tags st WHERE st.source_id=s.id AND st.tag_id=@tagId)" : ""}
          -- Never build a second card from a passage that already has one.
          AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.mention_id = m.id)
        ORDER BY RANDOM()
        LIMIT @limit`
    )
    .all({
      limit: limit ?? 24,
      ...(entityId ? { entityId } : {}),
      ...(tagId ? { tagId } : {}),
    }) as {
    id: number;
    quote: string;
    claim: string | null;
    entity_id: number;
    entity: string;
    source_id: number;
    source: string;
    locator_json: string;
    doc_label: string | null;
  }[];

  if (rows.length === 0) {
    finishTask(
      task.id,
      task.run_id,
      { tokensIn: 0, tokensOut: 0 },
      "skipped",
      "Every passage here already has a card."
    );
    return;
  }

  const material = rows
    .map((r) => `[[m:${r.id}]] ${r.entity} — ${r.source}\n   "${r.quote}"${r.claim ? `\n   claim: ${r.claim}` : ""}`)
    .join("\n\n");

  const { data, usage } = await generateJson<{
    cards: {
      kind: "card" | "quiz";
      front: string;
      back: string;
      distractors?: string[];
      mentionId: number;
    }[];
  }>({
    stage: "cards",
    system: SYSTEM,
    schema: SCHEMA,
    temperature: 0.4,
    sample: rows.slice(0, 6).map((r) => r.quote).join(" ").slice(0, 600),
    parts: [
      `Make up to ${Math.min(rows.length, 20)} cards from these passages. ` +
        `Roughly half plain flashcards and half multiple-choice.\n\nPASSAGES:\n${material}`,
    ],
  });

  const byMention = new Map(rows.map((r) => [r.id, r]));
  let written = 0;

  tx(() => {
    const stmt = db().prepare(
      `INSERT INTO cards (kind, front, back, distractors, quote, locator, entity_name,
                          entity_id, mention_id, source_id, tag_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const c of data.cards ?? []) {
      const origin = byMention.get(c.mentionId);
      // A card whose passage was not one we supplied is fabricated.
      if (!origin || !c.front?.trim() || !c.back?.trim()) continue;
      stmt.run(
        c.kind === "quiz" ? "quiz" : "card",
        c.front.trim(),
        c.back.trim(),
        JSON.stringify((c.distractors ?? []).filter(Boolean).slice(0, 3)),
        // The evidence is copied onto the card, not referenced: re-extracting a
        // source rewrites its mentions and a card must outlive that.
        origin.quote,
        formatLocator(JSON.parse(origin.locator_json) as Locator, origin.doc_label),
        origin.entity,
        origin.entity_id,
        origin.id,
        origin.source_id,
        tagId ?? null
      );
      written++;
    }
    finishTask(task.id, task.run_id, usage, "done", `Made ${written} card${written === 1 ? "" : "s"}.`);
  });
}
