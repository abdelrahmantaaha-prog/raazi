import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { finishTask } from "../queue";
import type { Task } from "../types";
import { citedIds, mentionsFor } from "./entry";

/**
 * Reads a finished entry back against its own citations.
 *
 * Everything else in this pipeline measures whether the evidence reached the
 * entry. Nothing measured whether the entry says what the evidence says, and
 * those are not the same question — an audit of the library found every entity
 * at 100% coverage with no dead citations, and inside one of them:
 *
 *   Al Saud is the ruling dynasty of Saudi Arabia [[m:36243]] [[m:36917]] ...
 *
 * where the cited passages are about Abdullah Sulaiman not being a member of it.
 * The sentence is true, and its truth comes from the model's own knowledge of
 * the world rather than from the books — which is the single thing this
 * application exists to prevent, wearing a citation so it cannot be seen.
 *
 * Structural checks cannot catch that. The marker is real, the mention exists,
 * it belongs to this entity, the sentence is cited. Only reading the quote and
 * the sentence together settles it.
 *
 * This pass reports and does not edit, for the same reason the draft fact-check
 * does: a rewrite would quietly bury the disagreement, and what you want to see
 * is the disagreement. Entries stay exactly as written; the flags sit beside
 * them.
 */

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    findings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          n: { type: Type.INTEGER, description: "The sentence number given to you." },
          verdict: {
            type: Type.STRING,
            enum: ["supported", "overstated", "unsupported"],
          },
          note: {
            type: Type.STRING,
            description:
              "Under 25 words, only when not 'supported'. Say what the passages do say instead.",
          },
        },
        required: ["n", "verdict"],
      },
    },
  },
  required: ["findings"],
};

const SYSTEM = `You are checking an encyclopedia entry against the passages it cites, one
sentence at a time. You are not editing it and not improving it.

For each numbered sentence you are given the passages it cites. Answer only from
those passages.

- "supported": the passages state this, or it follows from them directly. Close
  paraphrase is supported. A reasonable summary of several passages is supported.
- "overstated": the passages carry something weaker, narrower or more hedged.
  A passage saying an arrangement "could" do something does not support a
  sentence saying it did. A passage about one man's job does not support a
  sentence about a national condition.
- "unsupported": the passages do not say this. This includes sentences that are
  perfectly true in the world but simply absent from the evidence — that is the
  most important case here, and the easiest to wave through, because a false
  sentence looks wrong while a true unsourced one looks fine.

Judge only the sentence in front of you. Do not penalise it for what other
sentences do or do not say, and do not object to a sentence being uninteresting.
Most sentences should come back "supported"; say so and move on.`;

/** Sentences of the body that carry at least one citation. */
function citedSentences(body: string): { text: string; ids: number[] }[] {
  const prose = body
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .join(" ");

  return prose
    .split(/(?<=[.!?؟])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25 && /\[\[m:\d+\]\]/.test(s))
    .map((text) => ({ text, ids: [...citedIds(text)] }));
}

export async function handleVerify(task: Task): Promise<void> {
  const { entityId } = JSON.parse(task.payload_json) as { entityId: number };

  const entry = db().prepare("SELECT body_md FROM entries WHERE entity_id=?").get(entityId) as
    | { body_md: string }
    | undefined;
  if (!entry?.body_md.trim()) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "No entry to check.");
    return;
  }

  const sentences = citedSentences(entry.body_md);
  if (sentences.length === 0) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Nothing cited.");
    return;
  }

  const quotes = new Map(mentionsFor(entityId).map((m) => [m.id, m]));

  // Numbered rather than sent one per call: the whole point is cheap enough to
  // run on every entry, and a sentence needs only its own citations to judge.
  const block = sentences
    .map((s, i) => {
      const ev = s.ids
        .map((id) => {
          const m = quotes.get(id);
          if (!m) return null;
          const ctx = m.context ? `\n       in context: ${m.context}` : "";
          return `     [[m:${id}]] "${m.quote}"${ctx}`;
        })
        .filter(Boolean)
        .join("\n");
      return `${i + 1}. ${s.text.replace(/\[\[m:\d+\]\]/g, "").trim()}\n   CITES:\n${ev || "     (nothing)"}`;
    })
    .join("\n\n");

  const { data, usage } = await generateJson<{
    findings: { n: number; verdict: string; note?: string }[];
  }>({
    // Routed with the entry writer rather than as a stage of its own: it is a
    // judgement about entry prose, and splitting it out would put another knob
    // in the settings for something nobody would tune separately.
    stage: "entry",
    system: SYSTEM,
    schema: SCHEMA,
    parts: [`SENTENCES TO CHECK:\n\n${block}`],
    temperature: 0,
  });

  const bad = (data.findings ?? []).filter(
    (f) => f.verdict === "unsupported" || f.verdict === "overstated"
  );

  tx(() => {
    // Replaced wholesale: a flag against a sentence that has since been
    // rewritten is worse than no flag, because it sends you looking for
    // something that is no longer there.
    db().prepare("DELETE FROM entry_flags WHERE entity_id=?").run(entityId);

    const insert = db().prepare(
      `INSERT INTO entry_flags (entity_id, sentence, verdict, note, mention_ids)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const f of bad) {
      const s = sentences[f.n - 1];
      if (!s) continue;
      insert.run(entityId, s.text, f.verdict, f.note?.trim() || null, s.ids.join(","));
    }

    const checked = sentences.length;
    finishTask(
      task.id,
      task.run_id,
      usage,
      "done",
      bad.length === 0
        ? `${checked} sentences checked; all borne out by their citations.`
        : `${checked} sentences checked; ${bad.length} not borne out ` +
          `(${bad.filter((b) => b.verdict === "unsupported").length} unsupported, ` +
          `${bad.filter((b) => b.verdict === "overstated").length} overstated).`
    );
  });
}

/** What the audit and the UI read. */
export function flagsFor(entityId: number) {
  return db()
    .prepare("SELECT * FROM entry_flags WHERE entity_id=? ORDER BY id")
    .all(entityId) as {
    id: number;
    sentence: string;
    verdict: string;
    note: string | null;
    mention_ids: string;
  }[];
}
