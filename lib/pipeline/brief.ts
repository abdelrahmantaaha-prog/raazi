import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { getConfig } from "../config";
import { createRun, enqueue, finishTask } from "../queue";
import { gather, getBrief, hasMaterial, todayKey, type BriefMaterial, type BriefPassage } from "../brief";
import { describeWeek, isWeekKey, weekKey, weekRange } from "../week";
import { normaliseMarkers } from "../markers";
import type { Task } from "../types";

/**
 * The morning brief: what changed, with a citation on every line.
 *
 * The thing this must not become is a model reading the night's articles and
 * telling you about them. That is a summary of summaries, it cannot be
 * checked, and it is exactly the failure the rest of the application is built
 * to avoid. So the brief is assembled from the database first — which passages
 * arrived, about whom, from which outlet, at what time — and the model's only
 * job is to turn those rows into prose that reads in order, under the same
 * rule as an entry: every claim carries a marker, and a marker it was not
 * given is a fabrication.
 *
 * What that buys, beyond honesty: clicking any line in the brief opens the
 * passage, on the entity, in the pedia. The brief is a view of the library
 * rather than a document beside it.
 */

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    headline: {
      type: Type.STRING,
      description: "One sentence: the most consequential thing in this window, or what the day was quiet about.",
    },
    body: {
      type: Type.STRING,
      description:
        "The brief in Markdown, following the sections given. Every factual sentence ends with citation markers of the form [[m:ID]], written one per id and separated by spaces.",
    },
    questions: {
      type: Type.ARRAY,
      description: "Two or three things a reporter on this beat should now go and find out. No citations.",
      items: { type: Type.STRING },
    },
  },
  required: ["headline", "body"],
};

const SYSTEM = `You write a daily brief for a political journalist, from passages their own
library collected overnight. You are their desk assistant, not a wire service:
they will act on this, and they will click every citation.

ABSOLUTE RULES

- Every factual sentence ends with at least one citation marker naming the
  passage it rests on. A sentence you cannot cite is a sentence you must not
  write. Markers are written [[m:12]], several in a row separated by spaces:
  [[m:12]] [[m:15]]. Never [[m:12], [m:15]].
- Use only the passages supplied. You know a great deal about these subjects
  and about what happened before this window; none of it goes in. The brief
  reports what THESE sources said in THIS window.
- Name the outlet in the prose whenever a claim is not settled: "the Globe and
  Mail reported", "according to two officials cited by Reuters". An
  "attributed to" line under a passage tells you whose claim it is; a kind of
  "allegation", "opinion", "forecast" or "denial" means it must never be
  written as a fact.
- Say when only one outlet has something: "so far reported only by X". Say when
  several agree, and name them. Never merge two outlets' numbers into one
  figure — give the range and say who said which.
- Where the passages disagree, that IS the item. Lead with the disagreement,
  give both sides with their citations, and do not adjudicate.
- No speculation, no "this suggests", no analysis of what it means. What was
  said, by whom, when, and where they differ.

SHAPE

Follow the sections you are given, in the order given, and drop any section
with nothing in it rather than announcing that it is empty. Inside a section:

- One item per thing that happened, not one per passage. Several passages about
  the same development are one item carrying several markers.
- Newest first within an item; say when something happened when the passages
  date it.
- Two or three sentences an item. This is a brief; the entry is where the
  detail lives.
- Under "On your watchlist", group by the person or subject watched, using the
  heading given for it.
- A one-line item is fine. Padding a thin day is worse than a thin brief.

Write in the language you are told to use. Quote in the source's own language
where you quote at all, which should be rarely and only for words that matter.`;

/**
 * The weekly one, which is a different document written from the same rows.
 *
 * A daily brief answers "what came in overnight". A weekly one is delivered to
 * colleagues who did not read the dailies, so it has to say what MOVED across
 * the week — where a story on Friday is not where it was on Monday — and it
 * has to be readable by someone who is meeting the subject for the first time.
 * The citation rule does not soften: this is the version that gets quoted back
 * at you in a meeting, so every line still has to open the passage it rests on.
 */
const WEEKLY_SYSTEM = `You write the weekly brief for a political journalist covering North
America and foreign policy. They present from it at work, to people who have
not read a word of the week's coverage, and they will click every citation
before they say any of it out loud.

ABSOLUTE RULES

- Every factual sentence ends with at least one citation marker naming the
  passage it rests on. A sentence you cannot cite is a sentence you must not
  write. Markers are written [[m:12]], several in a row separated by spaces:
  [[m:12]] [[m:15]]. Never [[m:12], [m:15]].
- Use only the passages supplied. You know a great deal about these subjects
  and about what happened before this week; none of it goes in. This is what
  THESE sources said in THIS week.
- Name the outlet in the prose whenever a claim is not settled. An "attributed
  to" line tells you whose claim it is; a kind of "allegation", "opinion",
  "forecast" or "denial" means it must never be written as a fact.
- Say when only one outlet has something, and say when several agree and who.
  Never merge two outlets' numbers into one figure.
- Where the passages disagree, that IS the item. Lead with the disagreement,
  give both sides with their citations, and do not adjudicate.

SHAPE — this is a week, not a day

- Open with "The week in one paragraph": four or five sentences a colleague
  could read alone and be caught up. Cited like everything else.
- Then "What moved", the two to five developments that actually changed
  position over the week. For each, say where it stood at the start of the
  week and where it stands now, in that order — the movement is the story, and
  a list of what was said on which day is not. Several days' passages about one
  development are ONE item carrying several markers.
- Then "Still running", one line each for the threads that were live but did
  not move. Say plainly that they did not move.
- Then "New this week" for what appeared for the first time.
- Then, if the passages support them, "Where the reporting disagrees" and
  "Worth chasing next week". The second of these takes no citations: it is the
  only place in the document where you may write a question rather than a fact.
- Drop any section with nothing in it rather than announcing it is empty. A
  quiet week is a short brief, and padding it is worse.

Write in the language you are told to use. Quote in the source's own language
where you quote at all, and rarely.`;

/** Passages, as the writer sees them: dated, attributed, from a named outlet. */
function renderPassages(rows: BriefPassage[]): string {
  return rows
    .map((p) => {
      const when = (p.published_at ?? "").slice(0, 16).replace("T", " ");
      const where = [p.outlet, p.author, when].filter(Boolean).join(", ");
      const lines = [
        `[[m:${p.mention_id}]] on ${p.entity} (${p.entity_type})${where ? ` — ${where}` : ""}${
          p.story_title ? ` — story: "${p.story_title}"` : ""
        }`,
        `   "${p.quote}"`,
      ];
      if (p.claim) lines.push(`   claim: ${p.claim}`);
      if (p.context) lines.push(`   in context: ${p.context}`);
      if (p.attribution && p.attribution !== "source") lines.push(`   attributed to: ${p.attribution}`);
      if (p.claim_kind && p.claim_kind !== "fact") lines.push(`   kind: ${p.claim_kind}`);
      if (p.reliability) lines.push(`   about this outlet: ${p.reliability}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function material(m: BriefMaterial): string[] {
  const parts: string[] = [];

  if (m.watched.length) {
    parts.push(
      `SECTION "On your watchlist" — one sub-heading per subject below, in this order:\n\n` +
        m.watched
          .map(
            (w) =>
              `### ${w.label}${w.kind === "topic" ? " (topic)" : w.kind === "phrase" ? " (phrase watch)" : ""}\n${renderPassages(w.passages)}`
          )
          .join("\n\n")
    );
  }

  if (m.stories.length) {
    parts.push(
      `SECTION "Running stories" — these accounts were grouped as one story each. Say how many outlets carried it and name them:\n` +
        m.stories
          .map(
            (s) =>
              `- "${s.title}" — ${s.accounts} account${s.accounts === 1 ? "" : "s"}${
                s.outlets.length ? ` (${s.outlets.join(", ")})` : ""
              }, first seen ${s.first_seen.slice(0, 16)}`
          )
          .join("\n") +
        `\n(Cite the passages above and below; this list is context, not evidence.)`
    );
  }

  if (m.other.length) {
    parts.push(`SECTION "Also arrived" — everything else worth a line:\n${renderPassages(m.other)}`);
  }

  if (m.contradictions.length) {
    parts.push(
      `SECTION "Sources disagree" — recorded by the pedia in this window:\n` +
        m.contradictions
          .map(
            (c) =>
              `- ${c.entity}: "${c.claim_a}"${c.title_a ? ` (${c.title_a})` : ""} against "${c.claim_b}"${
                c.title_b ? ` (${c.title_b})` : ""
              }`
          )
          .join("\n")
    );
  }

  if (m.revised.length) {
    parts.push(
      `SECTION "Entries that changed" — the pedia rewrote these overnight. One line each, no citations needed:\n` +
        m.revised.map((r) => `- ${r.entity}: ${(r.changelog ?? "").replace(/\s+/g, " ").slice(0, 300)}`).join("\n")
    );
  }

  if (m.problems.length) {
    parts.push(
      `SECTION "Did not come in" — list these plainly at the end so they can be chased by hand:\n` +
        m.problems.map((p) => `- "${p.title}" from ${p.feed}: ${p.note ?? "failed"}`).join("\n")
    );
  }

  return parts;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ar: "Arabic",
  fr: "French",
  es: "Spanish",
  de: "German",
};

export async function handleBrief(task: Task): Promise<void> {
  const { day, hours } = JSON.parse(task.payload_json) as { day?: string; hours?: number };
  const key = day ?? todayKey();
  const free = { tokensIn: 0, tokensOut: 0 };

  // A week's key carries its own window; a day's is the last N hours, because
  // "today" for someone who opens the app at nine means since yesterday.
  const week = isWeekKey(key);
  const range = week ? weekRange(key) : null;
  const to = range ? new Date(Math.min(Date.now(), range.to.getTime())) : new Date();
  const from = range ? range.from : new Date(to.getTime() - (hours ?? 24) * 3600_000);
  const m = gather(from, to, week ? { perWatch: 30, maxOther: 150 } : {});

  const row = getBrief(key);
  if (!row) {
    db()
      .prepare(
        "INSERT INTO briefs (day, kind, state, window_from, window_to) VALUES (?, ?, 'pending', ?, ?)"
      )
      .run(key, week ? "week" : "day", m.from, m.to);
  }

  if (!hasMaterial(m)) {
    tx(() => {
      db()
        .prepare(
          `UPDATE briefs SET state='done', body_md=?, window_from=?, window_to=?, stats_json=?
            WHERE day=?`
        )
        .run(
          `Nothing came in between ${m.from.slice(0, 16).replace("T", " ")} and ${m.to
            .slice(0, 16)
            .replace("T", " ")}. No feed had anything new about the subjects you follow.`,
          m.from,
          m.to,
          JSON.stringify(m.counts),
          key
        );
      finishTask(task.id, task.run_id, free, "done", "Nothing to brief on.");
    });
    return;
  }

  const language = getConfig().entryLanguage || "en";
  const parts = [
    week
      ? `WINDOW: the week of ${describeWeek(key)}, ${m.from.slice(0, 10)} to ${m.to.slice(0, 10)}`
      : `WINDOW: ${m.from.slice(0, 16).replace("T", " ")} to ${m.to.slice(0, 16).replace("T", " ")}`,
    `WHAT ARRIVED: ${m.counts.sources} source(s), ${m.counts.passages} passage(s), ${m.counts.entities} subject(s), ${m.counts.stories} new stor${m.counts.stories === 1 ? "y" : "ies"}.`,
    ...material(m),
  ];

  const { data, usage } = await generateJson<{
    headline: string;
    body: string;
    questions?: string[];
  }>({
    stage: "brief",
    system: `${week ? WEEKLY_SYSTEM : SYSTEM}\n\nLANGUAGE: write in ${LANGUAGE_NAMES[language.split("-")[0]] ?? language}.`,
    schema: SCHEMA,
    temperature: 0.2,
    parts,
  });

  // Every marker the writer was given, and nothing else.
  const valid = new Set<number>([
    ...m.watched.flatMap((w) => w.passages.map((p) => p.mention_id)),
    ...m.other.map((p) => p.mention_id),
  ]);
  const body = normaliseMarkers(data.body ?? "").replace(/\s*\[\[m:(\d+)\]\]/g, (whole, id) =>
    valid.has(Number(id)) ? whole : ""
  );

  const full = [
    data.headline?.trim() ? `**${data.headline.trim()}**` : "",
    body.trim(),
    (data.questions ?? []).length
      ? `## Worth chasing\n\n${(data.questions ?? []).map((q) => `- ${q}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  tx(() => {
    db()
      .prepare(
        `UPDATE briefs SET body_md=?, state='done', window_from=?, window_to=?, stats_json=?,
                tokens_in=tokens_in+?, tokens_out=tokens_out+?, error=NULL
          WHERE day=?`
      )
      .run(full, m.from, m.to, JSON.stringify(m.counts), usage.tokensIn, usage.tokensOut, key);
    finishTask(
      task.id,
      task.run_id,
      usage,
      "done",
      `${week ? "Weekly brief" : "Brief"} for ${key}: ${m.counts.sources} source(s), ${m.watched.length} watched subject(s).`
    );
  });
}

/** Queues today's brief as its own run. Returns null when one is already done. */
export function queueBrief(opts: { day?: string; hours?: number; force?: boolean } = {}): { runId: number } | null {
  const key = opts.day ?? todayKey();
  const existing = getBrief(key);
  if (existing && existing.state === "done" && !opts.force) return null;

  return tx(() => {
    if (existing && opts.force) {
      db().prepare("UPDATE briefs SET state='pending' WHERE day=?").run(key);
    }
    const runId = createRun({
      kind: "brief",
      label: isWeekKey(key) ? `Weekly brief, ${describeWeek(key)}` : `Brief for ${key}`,
      budgetCap: getConfig().defaultBudget,
    });
    enqueue(runId, [{ kind: "brief" as const, payload: { day: key, hours: opts.hours ?? 24 } }]);
    return { runId };
  });
}

/** Queues this week's, or a named week's. The window comes from the key. */
export function queueWeeklyBrief(opts: { week?: string; force?: boolean } = {}): { runId: number } | null {
  return queueBrief({ day: opts.week ?? weekKey(), force: opts.force });
}

/** True when a brief is already queued or running. */
export function briefInFlight(): boolean {
  return (
    (
      db()
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind='brief' AND state IN ('pending','running')")
        .get() as { n: number }
    ).n > 0
  );
}
