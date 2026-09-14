import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { getConfig } from "../config";
import { finishTask } from "../queue";
import { normaliseMarkers } from "../markers";
import { expansionMaterial, getExpansion, type ExpandMaterial } from "../expansions";
import { LANGUAGE_NAMES, renderPassages } from "./brief";
import type { Task } from "../types";

/**
 * Writes an expanded look at one heading of a brief. See lib/expansions.ts for
 * what it is written from; this is the call, and the same guard the brief has
 * on what comes back — a marker the writer was not given is removed.
 */

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    body: {
      type: Type.STRING,
      description:
        "The expanded look in Markdown, in the shape given. Every factual sentence ends with citation markers of the form [[m:ID]], one per id, separated by spaces.",
    },
    questions: {
      type: Type.ARRAY,
      description: "Two to four things worth finding out next. No citations.",
      items: { type: Type.STRING },
    },
  },
  required: ["body"],
};

export const EXPAND_SYSTEM = `You write an expanded look at one topic from a political journalist's daily
brief. The brief gave it a few lines; they want to understand it properly
before they write or present on it. They will click every citation.

ABSOLUTE RULES

- Every factual sentence ends with at least one citation marker naming the
  passage it rests on. A sentence you cannot cite is a sentence you must not
  write. Markers are written [[m:12]], several in a row separated by spaces:
  [[m:12]] [[m:15]]. Never [[m:12], [m:15]].
- Use only the passages supplied. You know a great deal about this subject;
  none of it goes in. What you have that the brief did not is the rest of the
  cited articles and earlier coverage from the journalist's own library — use
  them, and nothing beyond them.
- Name the outlet whenever a claim is not settled. An "attributed to" line
  tells you whose claim it is; a kind of "allegation", "opinion", "forecast" or
  "denial" means it must never be written as a fact.
- Say when only one outlet has something, and when several agree, who. Never
  merge two outlets' numbers into one figure.
- Where the passages disagree, set out both sides with their citations and do
  not adjudicate.
- No speculation and no verdicts on what it means.
- Stay on the topic of the heading. Leave out passages that only touch it in
  passing, however interesting.

SHAPE

- Open with one paragraph that says where it stands now: the most important
  development first, then the rest in descending order of importance.
- Then "#### How it got here": the development in order, oldest to newest,
  dated wherever the passages date it. Give each stage its due — do not let
  the latest day crowd out the ones before it.
- Then "#### Who says what": the positions of the people and institutions
  involved, each attributed.
- Then, only where the passages support them, "#### Where the reporting
  disagrees" and "#### Not yet known" — what the passages themselves say is
  unresolved, cited.
- Drop any part with nothing in it. Length follows the material: a thin topic
  is a few paragraphs, a rich one may run to seven hundred words. Never pad.

Write in the language you are told to use. Quote in the source's own language
where you quote at all, and rarely.`;

/** What the writer is shown, in order: the topic, what the brief said, then the evidence. */
export function expandParts(m: ExpandMaterial): string[] {
  const parts = [
    `TOPIC: "${m.section.heading}", from the brief for ${m.day}.`,
    `WHAT THE BRIEF SAID ABOUT IT — for orientation only. It is not evidence; every marker in it points to a passage repeated below.\n\n${m.section.text}`,
    `PASSAGES THE BRIEF CITED (${m.cited.length}):\n\n${renderPassages(m.cited)}`,
  ];
  if (m.articles.length) {
    parts.push(
      `MORE FROM THOSE SAME ARTICLES (${m.articles.length}) — what the brief had no room for:\n\n${renderPassages(m.articles)}`
    );
  }
  if (m.background.length) {
    parts.push(
      `EARLIER COVERAGE IN THE LIBRARY (${m.background.length}), oldest first — for how it got here. The same citation rules apply:\n\n${renderPassages(m.background)}`
    );
  }
  return parts;
}

/** Every marker the writer was shown. */
export function validMarkers(m: ExpandMaterial): Set<number> {
  return new Set([...m.cited, ...m.articles, ...m.background].map((p) => p.mention_id));
}

/** The body as stored: markers normalised, unknown ones removed, questions at the end. */
export function composeExpansion(data: { body?: string; questions?: string[] }, valid: Set<number>): string {
  const body = normaliseMarkers(data.body ?? "")
    .replace(/\s*\[\[m:(\d+)\]\]/g, (whole, id) => (valid.has(Number(id)) ? whole : ""))
    .trim();
  if (!body) return "";
  const questions = (data.questions ?? []).map((q) => q.trim()).filter(Boolean);
  return [body, questions.length ? `#### Worth finding out\n\n${questions.map((q) => `- ${q}`).join("\n")}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

type Written = { body: string; questions?: string[] };

export async function handleExpand(task: Task): Promise<void> {
  const { expansionId } = JSON.parse(task.payload_json) as { expansionId?: number };
  const free = { tokensIn: 0, tokensOut: 0 };
  const row = expansionId ? getExpansion(expansionId) : undefined;
  if (!row) {
    finishTask(task.id, task.run_id, free, "skipped", "That expansion is gone.");
    return;
  }

  const fail = (message: string) =>
    db()
      .prepare("UPDATE brief_expansions SET state='failed', error=?, updated_at=datetime('now') WHERE id=?")
      .run(message.slice(0, 500), row.id);

  db()
    .prepare("UPDATE brief_expansions SET state='pending', error=NULL, updated_at=datetime('now') WHERE id=?")
    .run(row.id);

  const m = expansionMaterial(row.brief_day, row.heading);
  if (!m) {
    tx(() => {
      fail("The brief no longer has that heading, or nothing under it can still be cited — it may have been rewritten.");
      finishTask(task.id, task.run_id, free, "skipped", `Nothing left to expand under "${row.heading}".`);
    });
    return;
  }

  const language = getConfig().entryLanguage || "en";
  let result: { data: Written; usage: { tokensIn: number; tokensOut: number }; model?: string | null };
  try {
    result = await generateJson<Written>({
      stage: "brief",
      system: `${EXPAND_SYSTEM}\n\nLANGUAGE: write in ${LANGUAGE_NAMES[language.split("-")[0]] ?? language}.`,
      schema: SCHEMA,
      temperature: 0.2,
      parts: expandParts(m),
    });
  } catch (err) {
    // Said on the page, then handed to the worker, which decides whether the
    // provider's moment is worth waiting out. A retry puts the row back to pending.
    fail(err instanceof Error ? err.message : String(err));
    throw err;
  }

  const body = composeExpansion(result.data, validMarkers(m));
  tx(() => {
    if (!body) {
      fail("The writer returned nothing that could be cited. Try again.");
      finishTask(task.id, task.run_id, result.usage, "done", `The expansion of "${row.heading}" came back empty.`);
      return;
    }
    db()
      .prepare(
        `UPDATE brief_expansions SET state='done', body_md=?, error=NULL, model=?, stats_json=?,
                tokens_in=tokens_in+?, tokens_out=tokens_out+?, updated_at=datetime('now')
          WHERE id=?`
      )
      .run(body, result.model ?? null, JSON.stringify(m.counts), result.usage.tokensIn, result.usage.tokensOut, row.id);
    finishTask(
      task.id,
      task.run_id,
      result.usage,
      "done",
      `Expanded "${row.heading}": ${m.counts.cited} cited passage(s), ${m.counts.articles} more from the same articles, ${m.counts.background} from earlier coverage.`
    );
  });
}
