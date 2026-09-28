import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { getConfig } from "../config";
import { createRun, enqueue, finishTask } from "../queue";
import {
  coveredThrough,
  dayWindowFrom,
  gather,
  getBrief,
  hasMaterial,
  todayKey,
  type BriefMaterial,
  type BriefPassage,
  type DatedEvent,
  type PassageWhen,
} from "../brief";
import { formatDate, formatDateTime } from "../dates";
import { describeWeek, isWeekKey, weekKey, weekRange } from "../week";
import { normaliseMarkers } from "../markers";
import { logCalendar } from "../calendar";
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
  give both sides with their citations, and do not adjudicate. A disagreement
  is two outlets asserting incompatible things about the same fact. Earlier
  reporting overtaken by later reporting is a sequence, not a disagreement;
  two passages from one article are never a disagreement; a claim and its
  denial are one item ("X said, Y denied"), written as such.
- No speculation, no "this suggests", no analysis of what it means. What was
  said, by whom, when, and where they differ.

WHEN IT HAPPENED

- The brief reports what happened in the WINDOW. Every passage carries a
  "when" line: IN THIS WINDOW, STILL TO COME, BEFORE THIS WINDOW, or undated.
- A passage marked BEFORE THIS WINDOW is background: what the article
  reminded its readers of. Background may support a subordinate clause
  ("...the war, now in its seventh month") and never more. Never its own
  sentence, never an item, never the headline, never "X reported that Y
  happened" as though it were news. An order signed last year, a hearing in
  July, a primary lost in June, a ruling in February are not developments in
  a September brief, whatever the article's date.
- An undated passage is judged by its words: "told a hearing in July",
  "in a 2024 interview", "on his first day in office" are background too.
- Lead every item with the development inside the window, and say the day
  when a passage fixes it ("on Monday", "late on Sunday"). Something scheduled
  or expected is written as still to come, with its date.
- If nothing under a heading happened in the window, write nothing under it.

SHAPE

Follow the sections you are given, in the order given, and drop any section
with nothing in it rather than announcing that it is empty. Inside a section:

- One item per thing that happened, not one per passage. Several passages about
  the same development are one item carrying several markers.
- Within a heading, the most widely carried development first: the story line
  on a passage says how many outlets ran it. Then by recency.
- Two or three sentences an item. This is a brief; the entry is where the
  detail lives.
- Under "On your beat", the headings are topics rather than people. Write each
  as what happened in that area of coverage, not as a profile of anyone. Every
  passage has already been assigned to exactly one heading — never repeat an
  item under a second topic because it also touches that one, and never cite
  a marker under any heading but the one it was listed under. A heading left
  with nothing of its own is dropped, not filled from another's passages.
- The sections you write are "On your beat", "Also arrived" and, if the
  passages support it, "Sources disagree". The lists after them — running
  stories, entries that changed, what did not come in — are appended by the
  application; do not write them.
- The headline names the most widely carried development that happened in
  the window, and nothing that is background.
- A one-line item is fine. Padding a thin day is worse than a thin brief. A
  passage that is only a credit, a byline, a programme note or a
  publisher's boilerplate gets no line at all.

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
  give both sides with their citations, and do not adjudicate. A disagreement
  is two outlets asserting incompatible things about the same fact; earlier
  reporting overtaken by later reporting is movement, not disagreement.

WHEN IT HAPPENED

- Every passage carries a "when" line: IN THIS WINDOW, STILL TO COME, BEFORE
  THIS WINDOW, or undated. A passage marked BEFORE THIS WINDOW is background
  the article was reminding its readers of. It may set up where a
  development stood at the start of the week, in a subordinate clause; it is
  never itself something that moved, never an item under "New this week",
  never in the opening paragraph as though it happened this week.
- Say the day when a passage fixes it. Something scheduled is still to come,
  with its date.

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

/** How a passage's place in time is put to the writer. */
const WHEN_LABEL: Record<PassageWhen, string> = {
  within: "IN THIS WINDOW",
  ahead: "STILL TO COME",
  before: "BEFORE THIS WINDOW — background, not news",
  undated: "undated",
};

/** "2025 ('last year')", "14 Sep 2026 ('Monday')": the date as filed and as worded. */
function describeDated(d: DatedEvent): string {
  const iso = d.iso ?? "";
  const shown =
    /^\d{4}-\d{2}-\d{2}$/.test(iso) ? formatDate(iso) : /^--/.test(iso) ? `every ${iso.slice(2)}` : iso || "no date";
  return `${shown}${d.text ? ` ("${d.text}")` : ""}: ${d.summary}`;
}

/**
 * Passages, as the writer sees them: dated, attributed, from a named outlet.
 *
 * The "when" line is the one that stops background being written as news.
 * An article about a space-weapons announcement reminds its readers that
 * the president signed an order last year; without a date on the passage
 * the writer reported the order as Monday's development, and did, in every
 * brief until this line existed.
 */
export function renderPassages(rows: BriefPassage[]): string {
  return rows
    .map((p) => {
      const when = formatDateTime(p.published_at);
      const where = [p.outlet, p.author, when ? `published ${when}` : ""].filter(Boolean).join(", ");
      const lines = [
        `[[m:${p.mention_id}]] on ${p.entity} (${p.entity_type})${where ? ` — ${where}` : ""}${
          p.story_title ? ` — story: "${p.story_title}"` : ""
        }`,
        `   "${p.quote}"`,
      ];
      if (p.claim) lines.push(`   claim: ${p.claim}`);
      if (p.context) lines.push(`   in context: ${p.context}`);
      if (p.when) {
        const dated = (p.dated ?? []).slice(0, 3).map(describeDated);
        lines.push(`   when: ${WHEN_LABEL[p.when]}${dated.length ? ` — ${dated.join(" | ")}` : ""}`);
      }
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
      `SECTION "On your beat" — one sub-heading per topic below, in this order. Each article was filed under exactly one topic, so a passage's topic is the one it appears under:\n\n` +
        m.watched
          .map(
            (w) =>
              `### ${w.label}${w.kind === "topic" ? " (topic)" : w.kind === "phrase" ? " (phrase watch)" : ""} — ${
                w.sources
              } article${w.sources === 1 ? "" : "s"} kept\n${renderPassages(w.passages)}`
          )
          .join("\n\n")
    );
  }

  if (m.stories.length) {
    parts.push(
      `RUNNING STORIES (context, not evidence, and not a section for you to write — it is appended after your text): each is one event; "outlets" is how many different outlets carried it, and "kept" is how many of its accounts the journalist read, and the passages above come from those. An outlet often files several accounts of one event, so never give the number of accounts as a number of outlets. Use it to judge how widely a development was carried, and say so in the prose only for the story a passage names:\n` +
        m.stories
          .map(
            (s) =>
              `- "${s.title}" — carried by ${Math.max(1, s.outlets.length)} outlet${
                s.outlets.length > 1 ? "s" : ""
              }${s.outlets.length ? ` (${s.outlets.join(", ")})` : ""}; kept ${s.kept} of ${s.accounts} account${s.accounts === 1 ? "" : "s"}`
          )
          .join("\n")
    );
  }

  if (m.other.length) {
    parts.push(
      `SECTION "Also arrived" — one line per article at most, and only for what happened in the window:\n${renderPassages(m.other)}`
    );
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

  return parts;
}

/**
 * The sections that are lists rather than prose, written by the app.
 *
 * "Running stories", "Entries that changed" and "Did not come in" are rows,
 * and asking the writer to copy rows out was paying for a transcription
 * the writer then skipped: the first brief written under the tightened
 * prompt dropped all three. Appended after the model's text, they are
 * always there, always complete, and cost nothing.
 */
/** A trim the reader can see is a trim, rather than a sentence that stops. */
function trimTo(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > limit - 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/** A changelog line about the entry's own tidying rather than anything new. */
const HOUSEKEEPING =
  /^(removed|corrected|deleted|dropped|fixed|resolved|consolidated|restructured|reorgani[sz]ed|replaced|reworded|rephrased|rewrote|clarified|trimmed|merged|split|tightened|softened|converted|standardi[sz]ed|updated (the )?(dates?|wording|formatting|structure))\b/i;

/** A change to how the entry is laid out, whatever verb it opens with:
 *  "Added an opening lead paragraph … to establish the inverted pyramid". */
const LAYOUT = /\b(inverted pyramid|lead paragraph|section headings?|headings?|spine|structure|formatting|layout|chronological order|paragraph breaks?)\b/i;

export function fixedSections(m: BriefMaterial): string {
  const out: string[] = [];
  if (m.stories.length) {
    out.push(
      `## Running stories\n\n` +
        m.stories
          .map(
            (s) =>
              `- **${s.title.replace(/\s+/g, " ").trim()}** — kept ${s.kept} of ${s.accounts} account${
                s.accounts === 1 ? "" : "s"
              }${s.outlets.length ? ` (${s.outlets.join(", ")})` : ""}`
          )
          .join("\n")
    );
  }
  const revised = m.revised
    .map((r) => {
      // Split on a literal \n as well as a real one. A changelog that
      // came back double-escaped carries no line break to find, so the
      // whole list became "line one" and the trim below cut it
      // mid-word — "…as i" and "…for Chinese wor", both published on
      // 19 September. unescapeModelJson now repairs this on the way
      // in; the guard stays because a brief is assembled from rows
      // written long before it, and the old ones are still there.
      const lines = (r.changelog ?? "")
        .split(/\r?\n|\\n/)
        .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
        .filter(Boolean);
      // What the entry learned, not how it was tidied. The 27 September
      // brief listed 25 changes, most of them the verifier taking out a line
      // ("Removed the unsupported claim that Kuala Lumpur is the capital of
      // Malaysia"). An entry whose revision only tidied is left out.
      const news = lines.find((l) => !HOUSEKEEPING.test(l) && !LAYOUT.test(l));
      return news ? `- ${r.entity}: ${trimTo(news, 220)}` : null;
    })
    .filter((line): line is string => line !== null);
  if (revised.length) out.push(`## Entries that changed\n\n` + revised.join("\n"));
  if (m.problems.length) {
    // One line per feed once a feed fails more than twice: fourteen lines of
    // "Election Law Blog: Nothing readable was found" were most of the 27
    // September brief, and said one thing.
    const byFeed = new Map<string, typeof m.problems>();
    for (const p of m.problems) byFeed.set(p.feed, [...(byFeed.get(p.feed) ?? []), p]);
    const lines: string[] = [];
    for (const [feed, items] of byFeed) {
      if (items.length > 2) {
        const notes = [...new Set(items.map((p) => p.note ?? "failed"))];
        lines.push(`- ${items.length} items from ${feed}: ${notes.length === 1 ? notes[0] : "several failures"}`);
      } else {
        for (const p of items) lines.push(`- "${p.title.replace(/\s+/g, " ").trim()}" from ${p.feed}: ${p.note ?? "failed"}`);
      }
    }
    out.push(`## Did not come in\n\n` + lines.join("\n"));
  }
  return out.join("\n\n");
}

export const LANGUAGE_NAMES: Record<string, string> = {
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

  // A week's key carries its own window. A day's runs from wherever the last
  // brief stopped reading, with the configured hours as its minimum: "today"
  // for someone who opens the app at nine means since yesterday, and for
  // someone who took Friday off it means since Thursday. See dayWindowFrom.
  const week = isWeekKey(key);
  const range = week ? weekRange(key) : null;
  const to = range ? new Date(Math.min(Date.now(), range.to.getTime())) : new Date();
  const from = range ? range.from : dayWindowFrom(to, hours ?? 24, coveredThrough(key));
  const m = gather(from, to, week ? { perWatch: 30, maxOther: 150 } : {});

  // Every date these sources mention goes on the watching calendar before a
  // word of prose is written — an election three weeks out, a ruling due
  // "next month", the anniversary of an attack. The calendar is built from the
  // events extraction already recorded, so it costs nothing, and it is filed
  // whether or not there turns out to be enough material for a brief.
  const dated = logCalendar(from, to, key);
  if (dated > 0) console.log(`[corpus] calendar: ${dated} date(s) noticed for ${key}`);

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
          `Nothing came in between ${formatDateTime(m.from)} and ${formatDateTime(
            m.to
          )}. No feed had anything new about the subjects you follow.`,
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
      ? `WINDOW: the week of ${describeWeek(key)}, ${formatDate(m.from)} to ${formatDate(m.to)}`
      : `WINDOW: ${formatDateTime(m.from)} to ${formatDateTime(m.to)} (local time; every date below is local time)`,
    `WHAT ARRIVED: ${m.counts.sources} article(s) kept, ${m.counts.passages} passage(s), ${m.counts.entities} subject(s), touching ${m.counts.stories} running stor${m.counts.stories === 1 ? "y" : "ies"}.`,
    ...material(m),
  ];

  const { data, usage, model } = await generateJson<{
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
    fixedSections(m),
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
                tokens_in=tokens_in+?, tokens_out=tokens_out+?, model=?, error=NULL
          WHERE day=?`
      )
      .run(
        full,
        m.from,
        m.to,
        JSON.stringify(m.counts),
        usage.tokensIn,
        usage.tokensOut,
        model ?? null,
        key
      );
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
