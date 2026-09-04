import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { finishTask } from "../queue";
import type { Task } from "../types";

/**
 * Reads a finished entry as a reader would, and fixes how it hangs together.
 *
 * Entries are assembled from evidence in the order the evidence arrived, and
 * revised by bolting new material onto old. Both are the right way to stay
 * faithful to sources and the wrong way to produce prose: the result is an
 * entry where a man's education, a lawsuit, and a shipping contract share a
 * paragraph because those three quotes happened to come from the same book.
 * Every sentence is true and cited, and the entry is still incoherent.
 *
 * So a separate pass reads the whole thing at once — which the writer never
 * does, since it only ever sees the new evidence — and reorganises it.
 *
 * Since 2026-09-03 this no longer runs after every entry. The writer now sees
 * all of its evidence at once and plans the entry before writing it, which
 * removes the cause this pass was treating; and measured over 5,311 runs it
 * answered "fine" nine times, so it was churning every entry it saw into a new
 * revision. It stays available for a manual "tidy" of an entry you dislike.
 *
 * The hard constraint is that this pass may not *know* anything. It moves
 * sentences, groups them, writes headings and joins, and cuts repetition. It
 * does not add facts, and every citation marker it emits must be one the entry
 * already had. That is checked afterwards rather than trusted, because an
 * invented citation is the one failure this whole application exists to prevent.
 */

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    verdict: {
      type: Type.STRING,
      enum: ["fine", "reordered"],
      description: "'fine' if the entry already reads well and you changed nothing.",
    },
    body: {
      type: Type.STRING,
      description:
        "The reorganised entry in Markdown, with every [[m:ID]] marker carried over unchanged. Empty string when the verdict is 'fine'.",
    },
    note: {
      type: Type.STRING,
      description: "One sentence on what was wrong with the flow, or why it was already fine.",
    },
  },
  required: ["verdict", "note"],
};

const SYSTEM = `You are an editor. You are given an encyclopedia entry that was
assembled mechanically from evidence, and your job is to make it read as one
piece of writing.

What typically needs fixing:
- Unrelated facts sitting in the same paragraph because they came from the same
  source. Group by subject instead: what the person did, what was done to them,
  what they said, how others described them.
- The same fact stated twice in different words, usually because two sources
  said it and the entry was revised rather than rewritten. Keep one statement
  and carry BOTH citation markers onto it.
- Sections in an arbitrary order. Put the identifying material first, then
  chronology or theme, then contested and marginal material last.
- Headings that no longer describe what is under them, or a wall of text that
  needs headings and has none.
- Sentences that begin mid-thought because the material they followed was moved
  or removed in an earlier revision.
- A person introduced by a bare given name or a bare surname. The first time
  anyone appears, they should carry the fullest form available — "Steve Bechtel"
  rather than "Bechtel", "Prince Feisal bin Abdulaziz" rather than "Feisal".
  These sources are thick with relatives who share a name, and a first mention
  that does not distinguish them cannot be read by someone who does not already
  know the answer. Use ONLY the forms given in KNOWN NAMES or already present in
  the entry: expanding to a fuller form is editing, but inventing a patronymic
  the evidence never stated is exactly the kind of addition rule 1 forbids.

ABSOLUTE CONSTRAINTS — these are not style preferences:

1. Add no facts. Not one. You may not use anything you know about this subject
   from outside the entry. If the entry does not say it, it does not go in.
2. Every [[m:ID]] marker in your output must appear in the entry you were given,
   with the same number. Never invent a marker, never renumber one, never move a
   marker onto a sentence its evidence does not support.
3. Drop no cited fact. Merging two statements of the same fact is fine and
   carries both markers; silently losing one is not.
4. Keep the entry's language. An Arabic entry stays Arabic.
5. Preserve hedging and attribution exactly. "According to Heikal" must not
   become a flat assertion. Contested things stay contested.

If the entry already reads well, say so and change nothing — answer "fine" with
an empty body. That is a common and correct answer for a short entry, and
churning a good entry to look busy is worse than leaving it alone.

Formatting: a heading on its own line, a blank line before and after it, blank
lines between paragraphs. Never put a "##" in the middle of a line of prose.`;

/**
 * Every surface form recorded for the people this entry is about, and for those
 * it names alongside them.
 *
 * Supplied so the editor can turn "Bechtel" into "Steve Bechtel" without that
 * counting as new information: the fuller name is already on record, it simply
 * did not reach this sentence.
 */
function knownNames(entityId: number): string {
  const rows = db()
    .prepare(
      `SELECT DISTINCT e.canonical_name AS name,
              (SELECT group_concat(a.surface, ' | ') FROM aliases a WHERE a.entity_id = e.id) AS forms
         FROM entities e
        WHERE e.merged_into IS NULL
          AND (e.id = ?
            OR e.id IN (SELECT to_entity FROM relations WHERE from_entity = ?)
            OR e.id IN (SELECT from_entity FROM relations WHERE to_entity = ?))
        LIMIT 40`
    )
    .all(entityId, entityId, entityId) as { name: string; forms: string | null }[];

  const lines = rows
    .filter((r) => r.forms)
    .map((r) => `- ${r.name}: ${r.forms}`);

  return lines.length
    ? `KNOWN NAMES (the forms the sources use; do not invent others):\n${lines.join("\n")}`
    : "";
}

/** Below this there is no structure to get wrong, and nothing to gain. */
const MIN_CHARS = 400;

export async function handleCoherence(task: Task): Promise<void> {
  const { entityId } = JSON.parse(task.payload_json) as { entityId: number };
  const free = { tokensIn: 0, tokensOut: 0 };

  const row = db()
    .prepare(
      `SELECT e.canonical_name, e.type, e.disambiguator, en.body_md, en.summary
         FROM entities e JOIN entries en ON en.entity_id = e.id
        WHERE e.id = ? AND e.merged_into IS NULL`
    )
    .get(entityId) as
    | {
        canonical_name: string;
        type: string;
        disambiguator: string | null;
        body_md: string;
        summary: string;
      }
    | undefined;

  if (!row) {
    finishTask(task.id, task.run_id, free, "skipped", "No entry to read.");
    return;
  }
  if (row.body_md.trim().length < MIN_CHARS) {
    finishTask(task.id, task.run_id, free, "skipped", "Too short to be incoherent.");
    return;
  }

  const before = markers(row.body_md);

  const { data, usage } = await generateJson<{
    verdict: "fine" | "reordered";
    body?: string;
    note?: string;
  }>({
    stage: "entry",
    system: SYSTEM,
    schema: SCHEMA,
    temperature: 0.15,
    parts: [
      `ENTITY: ${row.canonical_name}${row.disambiguator ? ` — ${row.disambiguator}` : ""}\nTYPE: ${row.type}`,
      // The forms the sources actually used for the people in this entry, so a
      // bare first mention can be expanded without anything being invented.
      knownNames(entityId),
      `ENTRY:\n"""\n${row.body_md}\n"""`,
    ].filter(Boolean),
  });

  const body = (data.body ?? "").trim();

  if (data.verdict === "fine" || !body) {
    tx(() => finishTask(task.id, task.run_id, usage, "done", data.note || "Already reads well."));
    return;
  }

  // Trust nothing. An editor that quietly invented a citation, or dropped one,
  // would corrupt the record in exactly the way that is hardest to notice —
  // the entry would still look right.
  const after = markers(body);
  const invented = [...after].filter((id) => !before.has(id));
  const lost = [...before].filter((id) => !after.has(id));

  if (invented.length > 0) {
    tx(() =>
      finishTask(
        task.id,
        task.run_id,
        usage,
        "skipped",
        `Rejected: the rewrite cited ${invented.length} mention(s) the entry never had (${invented
          .slice(0, 5)
          .join(", ")}). Entry left as it was.`
      )
    );
    return;
  }

  if (lost.length > before.size * 0.2) {
    tx(() =>
      finishTask(
        task.id,
        task.run_id,
        usage,
        "skipped",
        `Rejected: the rewrite dropped ${lost.length} of ${before.size} citations, which is a rewrite rather than an edit. Entry left as it was.`
      )
    );
    return;
  }

  tx(() => {
    db()
      .prepare("UPDATE entries SET body_md=?, updated_at=datetime('now') WHERE entity_id=?")
      .run(body, entityId);

    // Recorded as a revision like any other, so the change is reversible and
    // visible rather than an entry silently rearranging itself overnight.
    db()
      .prepare(
        `INSERT INTO entry_revisions (entity_id, body_md, changelog_md)
         VALUES (?, ?, ?)`
      )
      .run(entityId, body, `Reorganised for flow: ${data.note ?? "grouped related material"}`);

    finishTask(task.id, task.run_id, usage, "done", data.note || "Reorganised.");
  });
}

function markers(body: string): Set<number> {
  return new Set([...body.matchAll(/\[\[m:(\d+)\]\]/g)].map((m) => Number(m[1])));
}
