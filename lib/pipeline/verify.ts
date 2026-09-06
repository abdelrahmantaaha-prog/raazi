import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { finishTask } from "../queue";
import type { Task } from "../types";
import { mentionsFor } from "./entry";
import { citedIds, hasMarker, stripMarkers } from "../markers";
import { paragraphSentences } from "../sentences";

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
 * Three things changed on 2026-09-03. Sentences are split by a splitter that
 * knows "U.S." is not the end of a sentence, because every false split was a
 * false flag and every false flag was a rewrite. The summary is checked as
 * sentence 0 against the whole body's citations, since it is what the drawer
 * shows first and it used to be the one unverified line. And a sentence with
 * no marker — the framing sentence the writer is now allowed at the top of a
 * paragraph — is judged against the citations of its own paragraph rather than
 * skipped, with "framing" as a permitted verdict: it passes if it only
 * summarises what the paragraph goes on to cite.
 *
 * This pass reports and does not edit. Entries stay exactly as written; the
 * flags sit beside them.
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
            enum: ["supported", "framing", "overstated", "unsupported"],
          },
          note: {
            type: Type.STRING,
            description:
              "Under 25 words, only when not 'supported' or 'framing'. Say what the passages do say instead.",
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

For each numbered sentence you are given the passages it cites, and the
sentence before it for orientation only (marked PRECEDED BY — do not judge it,
and do not use it as evidence). Answer only from the passages.

- "supported": the passages state this, or it follows from them directly. Close
  paraphrase is supported. A reasonable summary of several passages is supported.
- "framing": the sentence carries no citation of its own and is marked as a
  paragraph opener. It passes as "framing" if it only announces or summarises
  what the passages listed under it (the rest of its paragraph) establish, and
  adds no fact, date, name or judgement of its own. If it adds anything, judge
  it as "overstated" or "unsupported" like any other sentence.
- "overstated": the passages carry something weaker, narrower or more hedged.
  A passage saying an arrangement "could" do something does not support a
  sentence saying it did. A passage about one man's job does not support a
  sentence about a national condition. A claim the passage attributes to
  someone does not support the entry stating it flatly.
- "unsupported": the passages do not say this. This includes sentences that are
  perfectly true in the world but simply absent from the evidence — that is the
  most important case here, and the easiest to wave through, because a false
  sentence looks wrong while a true unsourced one looks fine.

Sentence 0, when present, is the entry's summary; its evidence is everything
the body cites. Judge it as "supported" if the body's citations carry it.

Judge only the sentence in front of you. Most sentences should come back
"supported"; say so and move on.`;

interface Sentence {
  text: string;
  ids: number[];
  /** Citations the sentence is judged against — its own, or its paragraph's. */
  evidenceIds: number[];
  framing: boolean;
  before: string | null;
}

/**
 * The sentences worth checking: every cited sentence, plus every uncited
 * sentence that sits in a paragraph with citations (a framing sentence, or an
 * escaped claim). An uncited sentence in an uncited paragraph has nothing to be
 * checked against and is left for the reader.
 */
export function sentencesToCheck(body: string): Sentence[] {
  const all = paragraphSentences(body);
  const byParagraph = new Map<number, number[]>();
  for (const s of all) {
    const ids = [...citedIds(s.text)];
    const list = byParagraph.get(s.paragraph) ?? [];
    list.push(...ids);
    byParagraph.set(s.paragraph, list);
  }

  const out: Sentence[] = [];
  all.forEach((s, i) => {
    const plain = stripMarkers(s.text);
    if (plain.length <= 25) return;
    const ids = [...citedIds(s.text)];
    const para = [...new Set(byParagraph.get(s.paragraph) ?? [])];
    if (ids.length === 0 && para.length === 0) return;
    const before = i > 0 && all[i - 1].paragraph === s.paragraph ? stripMarkers(all[i - 1].text) : null;
    out.push({
      text: s.text,
      ids,
      evidenceIds: ids.length ? ids : para,
      framing: ids.length === 0,
      before,
    });
  });
  return out;
}

export async function handleVerify(task: Task): Promise<void> {
  const { entityId } = JSON.parse(task.payload_json) as { entityId: number };
  const free = { tokensIn: 0, tokensOut: 0 };

  const entry = db()
    .prepare("SELECT summary, body_md FROM entries WHERE entity_id=?")
    .get(entityId) as { summary: string; body_md: string } | undefined;
  if (!entry?.body_md.trim()) {
    finishTask(task.id, task.run_id, free, "skipped", "No entry to check.");
    return;
  }
  if (!hasMarker(entry.body_md)) {
    finishTask(task.id, task.run_id, free, "skipped", "Nothing cited.");
    return;
  }

  const sentences = sentencesToCheck(entry.body_md);
  const bodyIds = [...citedIds(entry.body_md)];
  const summary = entry.summary?.trim();
  const items: Sentence[] = [
    ...(summary && summary.length > 15
      ? [{ text: summary, ids: [], evidenceIds: bodyIds, framing: false, before: null }]
      : []),
    ...sentences,
  ];
  if (items.length === 0) {
    finishTask(task.id, task.run_id, free, "skipped", "Nothing to check.");
    return;
  }
  const summaryOffset = summary && summary.length > 15 ? 1 : 0;

  const quotes = new Map(mentionsFor(entityId).map((m) => [m.id, m]));

  // Numbered rather than sent one per call: the whole point is cheap enough to
  // run on every entry, and a sentence needs only its own citations to judge.
  const block = items
    .map((s, i) => {
      const n = i + 1 - summaryOffset; // the summary is sentence 0
      const ev = s.evidenceIds
        .map((id) => {
          const m = quotes.get(id);
          if (!m) return null;
          const ctx = m.context ? `\n       in context: ${m.context}` : "";
          const who = m.attribution && m.attribution !== "source" ? `\n       attributed to: ${m.attribution}` : "";
          return `     [[m:${id}]] "${m.quote}"${ctx}${who}`;
        })
        .filter(Boolean)
        .join("\n");
      // The summary's evidence is the whole body; listing sixty quotes for it is
      // wasteful, so it gets the first twenty and the note that there are more.
      const evShown = n === 0 && s.evidenceIds.length > 20 ? `${ev.split("\n").slice(0, 40).join("\n")}\n     (and more)` : ev;
      const label = n === 0 ? "0. [SUMMARY] " : `${n}. ${s.framing ? "[PARAGRAPH OPENER, uncited] " : ""}`;
      const before = s.before ? `\n   PRECEDED BY: ${s.before}` : "";
      return `${label}${stripMarkers(s.text)}${before}\n   CITES:\n${evShown || "     (nothing)"}`;
    })
    .join("\n\n");

  const { data, usage } = await generateJson<{
    findings: { n: number; verdict: string; note?: string }[];
  }>({
    // Routed with the entry writer rather than as a stage of its own: it is a
    // judgement about entry prose.
    stage: "verify",
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
      const s = items[f.n - 1 + summaryOffset];
      if (!s) continue;
      insert.run(entityId, f.n === 0 ? `[summary] ${s.text}` : s.text, f.verdict, f.note?.trim() || null, s.evidenceIds.join(","));
    }

    const checked = items.length;
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
