import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { finishTask } from "../queue";
import { needsContext } from "../deixis";
import type { Task } from "../types";
import { precedingText } from "./extract";

/**
 * Giving a quote back its bearings.
 *
 * The extractor is asked, while it reads, to record what a back-reference points
 * at. Measured against a real library it did so for 6% of its quotes, while a
 * third of them open with a plain backward reference — and the zero-token sweep,
 * which supplies an eighth of all evidence, cannot do it at all, because it
 * never reads anything except the one sentence its regex matched. The result is
 * entries built on sentences like "Immediately, Steve Bechtel knew he was being
 * rebuffed": true, cited, and impossible to use.
 *
 * Two things were wrong with fixing that by asking the extractor more firmly.
 * It does not work — the instruction was already there, in capitals, with an
 * example — and it cannot reach anything already extracted, which is the whole
 * library. Resolution is also a genuinely different job from extraction: it
 * needs the paragraph *before* the quote more than the quote itself, and it has
 * one question rather than twelve.
 *
 * So it is its own pass. Quotes are screened mechanically by lib/deixis.ts,
 * every unresolved quote in a passage is asked about in a single call, and the
 * model is allowed to answer "it stands alone" — which is what makes it safe for
 * the screen to over-select.
 *
 * What it must not do is invent. A resolution that guesses which incident was
 * meant is worse than the gap it fills, because the gap is visible and the guess
 * is not.
 */

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    resolutions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.INTEGER, description: "The quote's id, as given." },
          refersTo: {
            type: Type.STRING,
            description:
              "What the quote leans on, named in a few words, taken from the surrounding text. Empty string if it stands on its own or if the text does not say.",
          },
        },
        required: ["id"],
      },
    },
  },
  required: ["resolutions"],
};

const SYSTEM = `You restore the context of quotations taken out of a book.

You are given a PASSAGE, the EARLIER TEXT that came before it, and a list of
QUOTES drawn from the passage. Each quote leans on something it does not itself
name — a pronoun with no antecedent, "the agreement", "following one incident",
"he was rebuffed" with no one doing the rebuffing.

For each quote, say what it points at, in a few words, so that a reader who sees
only the quote and your note understands it.

  Quote:     "Following one incident for which Iran blamed Saudi Arabia, Tehran
              went so far as to suggest transferring custody of the Two Holy
              Mosques to Iran."
  refersTo:  "the 2015 Mina stampede during the hajj, in which hundreds of
              Iranian pilgrims died"

  Quote:     "Immediately, Steve Bechtel knew he was being rebuffed."
  refersTo:  "Bechtel's 1951 meeting with King Abdulaziz, where he asked the
              Saudis to settle their unpaid construction bills"

The rules, and the second one is the one that matters:

- Answer ONLY from the PASSAGE and the EARLIER TEXT. You will often recognise
  these events from your own knowledge. That knowledge is not evidence and must
  not appear in your answer.
- If the text in front of you does not say what the quote refers to, return an
  empty string. A missing answer is a known gap; a plausible answer that the
  source does not support is a fabrication that will be cited as fact.
- Some quotes will turn out to stand perfectly well on their own. Return an
  empty string for those too. You are not required to find something to say
  about every quote.
- Do not restate the quote, do not interpret it, and do not add commentary. Name
  the thing it points at, and stop.
- Write in the language of the passage.`;

interface Row {
  id: number;
  quote: string;
  entity_id: number;
}

/** Above this, the call stops being one focused question. */
const MAX_QUOTES_PER_CALL = 25;

export async function handleContext(task: Task): Promise<void> {
  const { chunkId } = JSON.parse(task.payload_json) as { chunkId: number };
  const free = { tokensIn: 0, tokensOut: 0 };

  const chunk = db()
    .prepare(
      `SELECT c.id, c.source_id, c.seq, c.text, s.lang AS source_lang
         FROM chunks c JOIN sources s ON s.id = c.source_id
        WHERE c.id = ?`
    )
    .get(chunkId) as
    | { id: number; source_id: number; seq: number; text: string; source_lang: string | null }
    | undefined;

  if (!chunk) {
    finishTask(task.id, task.run_id, free, "skipped", "Passage no longer exists.");
    return;
  }

  const candidates = (
    db()
      .prepare(
        `SELECT id, quote, entity_id FROM live_mentions
          WHERE chunk_id = ? AND (context IS NULL OR context = '')`
      )
      .all(chunkId) as Row[]
  ).filter((r) => needsContext(r.quote).needs);

  if (candidates.length === 0) {
    finishTask(task.id, task.run_id, free, "skipped", "Nothing here needs its bearings.");
    return;
  }

  const batch = candidates.slice(0, MAX_QUOTES_PER_CALL);
  const earlier = precedingText(chunk.source_id, chunk.seq);

  const { data, usage } = await generateJson<{
    resolutions: { id: number; refersTo?: string }[];
  }>({
    stage: "extract",
    lang: chunk.source_lang ?? undefined,
    sample: chunk.text.slice(0, 600),
    system: SYSTEM,
    schema: SCHEMA,
    temperature: 0.1,
    parts: [
      [
        earlier
          ? `EARLIER TEXT:\n"""\n${earlier}\n"""`
          : `EARLIER TEXT: none — this is the beginning of the source.`,
        `\nPASSAGE:\n"""\n${chunk.text}\n"""`,
        `\nQUOTES:\n${batch.map((r) => `[${r.id}] "${r.quote}"`).join("\n\n")}`,
      ].join("\n"),
    ],
  });

  const valid = new Map(batch.map((r) => [r.id, r]));
  let filled = 0;
  const touched = new Set<number>();

  tx(() => {
    const write = db().prepare("UPDATE mentions SET context=? WHERE id=?");
    for (const r of data.resolutions ?? []) {
      const row = valid.get(r.id);
      if (!row) continue;
      const text = r.refersTo?.trim();
      if (!text) continue;

      // A "resolution" that merely repeats the quote resolves nothing, and a
      // one-word one says nothing either. Both are cheaper to drop than to
      // explain to a reader.
      if (text.length < 8) continue;
      if (row.quote.toLowerCase().includes(text.toLowerCase())) continue;

      write.run(text, row.id);
      touched.add(row.entity_id);
      filled++;
    }

    // An entry written from a quote that has just gained its context should be
    // written again — that is the whole point of recovering it.
    if (touched.size) {
      const stale = db().prepare(
        "UPDATE entities SET entry_state='stale' WHERE id=? AND entry_state='fresh'"
      );
      for (const id of touched) stale.run(id);
    }

    finishTask(
      task.id,
      task.run_id,
      usage,
      "done",
      `${filled} of ${batch.length} quote(s) given their bearings` +
        (candidates.length > batch.length ? `; ${candidates.length - batch.length} left for a later pass.` : ".")
    );
  });
}

/**
 * Decides which passages need a resolution call, and queues them.
 *
 * A free bookkeeping step, like plan_entries, and placed for the same kind of
 * reason: it has to run after the sweep, whose quotes are the ones most likely
 * to be adrift, and before entries are written, because an entry built from a
 * dangling quote is the thing being prevented. Queueing a call per passage
 * unconditionally would have been simpler and would have spent a call on every
 * passage in the book to find the one in four that needed it.
 */
export async function handlePlanContext(task: Task): Promise<void> {
  const { sourceId } = JSON.parse(task.payload_json) as { sourceId: number };
  const free = { tokensIn: 0, tokensOut: 0 };

  const { chunkIds, quotes } = passagesNeedingContext(sourceId);
  if (chunkIds.length === 0) {
    finishTask(task.id, task.run_id, free, "done", "Every quote stands on its own.");
    return;
  }

  const { enqueue } = await import("../queue");
  tx(() => {
    enqueue(
      task.run_id,
      chunkIds.map((chunkId) => ({ kind: "context" as const, payload: { chunkId } }))
    );
    finishTask(
      task.id,
      task.run_id,
      free,
      "done",
      `${quotes} quote(s) across ${chunkIds.length} passage(s) need their bearings.`
    );
  });
}

/**
 * The passages in a source holding quotes that cannot stand on their own.
 *
 * Used both to queue the work and to report how much of it there is, so the
 * button can say what it will cost before you press it.
 */
export function passagesNeedingContext(sourceId: number): { chunkIds: number[]; quotes: number } {
  const rows = db()
    .prepare(
      `SELECT m.id, m.quote, m.chunk_id FROM live_mentions m
        WHERE m.source_id = ? AND (m.context IS NULL OR m.context = '')`
    )
    .all(sourceId) as { id: number; quote: string; chunk_id: number }[];

  const chunks = new Set<number>();
  let quotes = 0;
  for (const r of rows) {
    if (!needsContext(r.quote).needs) continue;
    chunks.add(r.chunk_id);
    quotes++;
  }
  return { chunkIds: [...chunks], quotes };
}
