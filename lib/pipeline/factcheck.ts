import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { finishTask } from "../queue";
import type { Task } from "../types";
import { citationOf, retrieve, type Passage } from "./ask";

/**
 * Checks a draft against the library, and does nothing else.
 *
 * This is the only place a model touches the writing desk, and its remit is
 * deliberately narrow: it reports, it does not edit. No rewriting, no
 * suggestions, no "you might also mention". You wrote the draft; the question
 * on the table is only whether your own sources bear it out.
 *
 * "Unsupported" means the library has nothing to say either way — which for a
 * private research library is the common case and not an accusation. It is
 * called out separately from "contradicted" for that reason, because conflating
 * the two would make the report useless: everything you know from outside your
 * sources would come back flagged as wrong.
 *
 * Two calls per segment. The first, cheap one lists the checkable claims; the
 * evidence is then retrieved per claim, and the second call judges. Retrieving
 * with the whole segment as the query handed the judge passages that merely
 * shared vocabulary with six thousand characters of prose, and it judged the
 * claims against those.
 */

const CLAIMS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    claims: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          claim: {
            type: Type.STRING,
            description:
              "One checkable factual assertion, self-contained: names in place of pronouns, the date or figure it turns on included.",
          },
          kind: {
            type: Type.STRING,
            enum: ["fact", "figure", "date", "quotation", "attribution"],
          },
        },
        required: ["claim", "kind"],
      },
    },
  },
  required: ["claims"],
};

const CLAIMS_SYSTEM = `You list the factual assertions in a piece of writing so that each can
be checked against a library of sources. You do not judge them.

- One entry per checkable assertion, in the draft's own language, worded so it
  can be searched for on its own: replace pronouns and "the minister" with the
  name the draft uses, and keep the figure, date or quotation the claim turns on.
- Skip opinions, arguments, framing, transitions, questions and the writer's
  own interpretation. An argument is not a fact to be checked.
- Split a sentence that makes two assertions into two entries.
- At most forty entries. Return an empty list for a draft with nothing checkable.`;

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    claims: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          claim: {
            type: Type.STRING,
            description: "The factual assertion from the draft, quoted or closely paraphrased.",
          },
          verdict: {
            type: Type.STRING,
            enum: ["supported", "partly", "unsupported", "contradicted"],
          },
          note: {
            type: Type.STRING,
            description:
              "One sentence. For 'contradicted' and 'partly', say exactly what the evidence says instead.",
          },
          mentions: {
            type: Type.ARRAY,
            items: { type: Type.INTEGER },
            description: "Mention IDs from the EVIDENCE that bear on this claim.",
          },
        },
        required: ["claim", "verdict"],
      },
    },
  },
  required: ["claims"],
};

const SYSTEM = `You are checking a researcher's draft against their own collected
sources. You are not editing it. Do not suggest rewrites, do not comment on
style, do not propose additions.

For each claim in CLAIMS TO CHECK, decide how the EVIDENCE bears on it:

- supported: the evidence states it.
- partly: the evidence supports part of it, or supports it with a qualification
  the draft drops. Say which part in the note.
- unsupported: the evidence neither confirms nor denies it. This is NOT a
  criticism. A private library is small, and most true statements will not
  appear in it. Use this verdict freely and without implying error.
- contradicted: the evidence asserts something incompatible. Say what it asserts.

Rules:
- Judge ONLY against the EVIDENCE given. You know a great deal about these
  subjects; using it here would defeat the entire purpose, because the point is
  to learn what THIS library supports. A claim you personally know to be true is
  "unsupported" if the evidence does not carry it.
- Cite the mention IDs that bear on each claim, for supported, partly and
  contradicted alike.
- Each passage carries its outlet and date. Evidence from a later source does
  not cancel an earlier one; where they differ, say which says what.
- The DRAFT is there for context. Check the claims listed, not sentences you
  find in the draft that are not on the list.
- Do not invent mention IDs. Only use IDs present in the EVIDENCE.
- Quote the claim in the draft's own language.`;

/** Draft characters per call. Keeps a long essay to a handful of requests. */
const SEGMENT = 6000;
/** Passages retrieved for each claim, and the ceiling on their union. */
const PER_CLAIM = 10;
const EVIDENCE_CAP = 60;

interface Verdict {
  claim: string;
  verdict: "supported" | "partly" | "unsupported" | "contradicted";
  note?: string;
  mentions?: number[];
}

export interface CheckReport {
  claims: (Verdict & { citations: { id: number; quote: string; source: string; locator: string }[] })[];
  checkedAt: string;
  segments: number;
}

export async function handleFactcheck(task: Task): Promise<void> {
  const { draftId } = JSON.parse(task.payload_json) as { draftId: number };

  const draft = db().prepare("SELECT id, title, body_md FROM drafts WHERE id=?").get(draftId) as
    | { id: number; title: string; body_md: string }
    | undefined;

  if (!draft || !draft.body_md.trim()) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Nothing written yet.");
    return;
  }

  const segments = splitDraft(draft.body_md, SEGMENT);
  const all: CheckReport["claims"] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  for (const segment of segments) {
    // Step one: what does this segment assert? Cheap, and routed with the
    // reading stage because it is the same kind of work — text in, list out.
    const listed = await generateJson<{ claims: { claim: string; kind?: string }[] }>({
      stage: "extract",
      sample: segment.slice(0, 600),
      system: CLAIMS_SYSTEM,
      schema: CLAIMS_SCHEMA,
      temperature: 0,
      parts: [`DRAFT:\n"""\n${segment}\n"""`],
    });
    tokensIn += listed.usage.tokensIn;
    tokensOut += listed.usage.tokensOut;

    const claims = (listed.data.claims ?? []).map((c) => c.claim?.trim()).filter(Boolean) as string[];
    if (!claims.length) continue;

    // Step two: evidence for each claim, by full-text search on the claim's
    // own words. No model chooses what the checker gets to see.
    const passages = evidenceFor(claims);
    const byId = new Map(passages.map((p) => [p.id, p]));

    const { data, usage } = await generateJson<{ claims: Verdict[] }>({
      stage: "entry",
      sample: segment.slice(0, 600),
      system: SYSTEM,
      schema: SCHEMA,
      temperature: 0.1,
      parts: [
        `DRAFT:\n"""\n${segment}\n"""`,
        `CLAIMS TO CHECK:\n${claims.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
        passages.length
          ? `EVIDENCE from the library:\n${passages
              .map((p) => `[[m:${p.id}]] (${citationOf(p)}) — on ${p.entity}\n   "${p.quote}"`)
              .join("\n\n")}`
          : `EVIDENCE: the library returned nothing for these claims. Every one is therefore "unsupported".`,
      ],
    });

    tokensIn += usage.tokensIn;
    tokensOut += usage.tokensOut;

    for (const c of data.claims ?? []) {
      if (!c.claim?.trim()) continue;
      // Drop invented ids rather than showing a citation that goes nowhere,
      // and show each sentence once. One passage naming three entities becomes
      // three mentions, all carrying the same quote, so citing "the passage
      // about Tariki, Perez Alfonso and OPEC" otherwise printed it three times.
      const seenQuotes = new Set<string>();
      const citations = (c.mentions ?? [])
        .map((id) => byId.get(id))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .filter((p) => {
          const key = `${p.source}|${p.locator}|${p.quote.replace(/\s+/g, " ").trim()}`;
          if (seenQuotes.has(key)) return false;
          seenQuotes.add(key);
          return true;
        })
        .map((p) => ({ id: p.id, quote: p.quote, source: p.source, locator: p.locator }));

      all.push({ ...c, claim: c.claim.trim(), citations });
    }
  }

  const report: CheckReport = {
    claims: all,
    checkedAt: new Date().toISOString(),
    segments: segments.length,
  };

  const counts = all.reduce<Record<string, number>>((acc, c) => {
    acc[c.verdict] = (acc[c.verdict] ?? 0) + 1;
    return acc;
  }, {});

  tx(() => {
    db()
      .prepare("UPDATE drafts SET check_json=?, checked_at=datetime('now') WHERE id=?")
      .run(JSON.stringify(report), draftId);
    finishTask(
      task.id,
      task.run_id,
      { tokensIn, tokensOut },
      "done",
      `${all.length} claim(s) checked: ${counts.supported ?? 0} supported, ${
        counts.partly ?? 0
      } partly, ${counts.contradicted ?? 0} contradicted, ${counts.unsupported ?? 0} not covered.`
    );
  });
}

/**
 * The union of each claim's best passages, in claim order, each passage once,
 * capped so the judging call stays one call. Round-robin rather than
 * first-come, so a segment's last claim is not the one left without evidence
 * when the cap bites.
 */
export function evidenceFor(claims: string[]): Passage[] {
  const perClaim = claims.map((c) => retrieve(c, undefined, PER_CLAIM));
  const out = new Map<number, Passage>();
  for (let i = 0; i < PER_CLAIM && out.size < EVIDENCE_CAP; i++) {
    for (const list of perClaim) {
      const p = list[i];
      if (p && !out.has(p.id)) out.set(p.id, p);
      if (out.size >= EVIDENCE_CAP) break;
    }
  }
  return [...out.values()];
}

/** Splits on paragraph boundaries, never mid-sentence. */
function splitDraft(body: string, size: number): string[] {
  const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim());
  const out: string[] = [];
  let buf: string[] = [];
  let n = 0;

  for (const p of paragraphs) {
    if (n > 0 && n + p.length > size) {
      out.push(buf.join("\n\n"));
      buf = [];
      n = 0;
    }
    buf.push(p);
    n += p.length;
  }
  if (buf.length) out.push(buf.join("\n\n"));
  return out.length ? out : [body];
}
