import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { normalize } from "../normalize";
import { enqueue, finishTask } from "../queue";
import type { Task } from "../types";
import { formatLocator } from "../chunk";

/**
 * Asks whether an entry's evidence is all about the same person.
 *
 * Resolution decides identity from *names*, and names are a bad guide in a
 * library like this one. "ʿAbd al-ʿAziz" is the founding king of Saudi Arabia
 * and also the son of Abdullah al-Sulayman, his finance minister; the strings
 * are identical and the men are not. By the time the mistake is visible it has
 * already happened, and it is invisible in the place you would look — the entry
 * reads perfectly well, because a fluent paragraph about two people is still a
 * fluent paragraph.
 *
 * So the last thing that happens to an entry is that its evidence is read back
 * and asked the question resolution could not: do these quotes describe one
 * life? Names are deliberately *not* the evidence here — dates, offices,
 * relatives and roles are. Two men called Abdulaziz who cannot both have been
 * king in 1932 are two men.
 *
 * When the answer is no, the foreign quotes are moved to an entity of their own
 * and a standing verdict is written so the resolver never puts them back. This
 * is reversible in the ordinary way: the two can be merged again by hand.
 */

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    verdict: {
      type: Type.STRING,
      enum: ["one", "several"],
      description: "'one' if every passage describes the same individual.",
    },
    reason: { type: Type.STRING, description: "One sentence saying how you can tell." },
    other: {
      type: Type.OBJECT,
      description: "The person the minority of passages are about. Omit when the verdict is 'one'.",
      properties: {
        name: { type: Type.STRING, description: "Their name as the passages give it." },
        disambiguator: {
          type: Type.STRING,
          description: "Three to six words fixing which one this is.",
        },
        mentions: {
          type: Type.ARRAY,
          items: { type: Type.INTEGER },
          description: "IDs of the passages about this second person.",
        },
      },
      required: ["name", "mentions"],
    },
  },
  required: ["verdict", "reason"],
};

const SYSTEM = `You are checking whether an encyclopedia entry has conflated two
people who share a name.

You are given the entry's subject and the passages collected as evidence for it.
Decide whether every passage describes the SAME individual.

How to tell them apart — and note that the *name* is no help at all, because a
shared name is exactly how this mistake happens:

- Incompatible facts about one life. Two men cannot both be the king and the
  king's finance minister's son; one person is not born in two decades.
- Different relatives. "son of Abdullah al-Sulayman" and "son of Abd al-Rahman"
  are different men however alike their own names are.
- Different offices held at the same time.
- One is described as the other's subordinate, rival, employee or child.

Answer "one" unless the evidence positively shows otherwise. A passage that
simply says little is not evidence of a second person, and splitting an entry on
a hunch scatters a subject across two half-entries — which is harder to notice,
and harder to undo, than leaving it whole. Names that merely look alike, or
transliteration variants of the same name, are not grounds for anything.

When you answer "several", put the SMALLER group in "other": the entry keeps the
person most of its evidence is about, and the minority is split out. List every
passage id belonging to that second person, and give them a name and
disambiguator drawn from the passages themselves.`;

interface Row {
  id: number;
  quote: string;
  claim: string | null;
  context: string | null;
  surface: string;
  source_id: number;
  source_title: string;
  locator_json: string;
  doc_label: string | null;
}

/** Below this there is not enough evidence for a conflation to be visible. */
const MIN_EVIDENCE = 4;
/** Above this the prompt is enormous and the question is answerable without it. */
const MAX_EVIDENCE = 60;

export async function handleIdentity(task: Task): Promise<void> {
  const { entityId } = JSON.parse(task.payload_json) as { entityId: number };
  const free = { tokensIn: 0, tokensOut: 0 };

  const entity = db()
    .prepare(
      "SELECT id, canonical_name, type, disambiguator FROM entities WHERE id=? AND merged_into IS NULL"
    )
    .get(entityId) as
    | { id: number; canonical_name: string; type: string; disambiguator: string | null }
    | undefined;

  // Only people. Organisations and places share names constantly and legitimately
  // ("Ministry of Finance"), and the tests that separate two men do not apply.
  if (!entity || entity.type !== "person") {
    finishTask(task.id, task.run_id, free, "skipped", "Not a person.");
    return;
  }

  const rows = db()
    .prepare(
      `SELECT m.id, m.quote, m.claim, m.context, m.surface, m.source_id,
              s.title AS source_title, c.locator_json, d.label AS doc_label
         FROM live_mentions m
         JOIN sources s ON s.id = m.source_id
         JOIN chunks  c ON c.id = m.chunk_id
    LEFT JOIN documents d ON d.id = c.doc_id
        WHERE m.entity_id = ?
        ORDER BY m.id
        LIMIT ?`
    )
    .all(entityId, MAX_EVIDENCE) as Row[];

  if (rows.length < MIN_EVIDENCE) {
    finishTask(task.id, task.run_id, free, "skipped", "Too little evidence to judge.");
    return;
  }

  const { data, usage } = await generateJson<{
    verdict: "one" | "several";
    reason?: string;
    other?: { name: string; disambiguator?: string; mentions: number[] };
  }>({
    stage: "resolve",
    sample: rows.map((r) => r.quote).join(" ").slice(0, 600),
    system: SYSTEM,
    schema: SCHEMA,
    temperature: 0.1,
    parts: [
      `SUBJECT: ${entity.canonical_name}${entity.disambiguator ? ` — ${entity.disambiguator}` : ""}`,
      `EVIDENCE:\n${rows
        .map((r) => {
          const where = [r.source_title, formatLocator(JSON.parse(r.locator_json), r.doc_label)]
            .filter(Boolean)
            .join(", ");
          const extra = [r.claim && `claim: ${r.claim}`, r.context && `refers to: ${r.context}`]
            .filter(Boolean)
            .join("\n   ");
          return `[${r.id}] (${where}, as "${r.surface}")\n   "${r.quote}"${extra ? `\n   ${extra}` : ""}`;
        })
        .join("\n\n")}`,
    ],
  });

  const valid = new Set(rows.map((r) => r.id));
  const foreign = (data.other?.mentions ?? []).filter((id) => valid.has(id));
  const name = data.other?.name?.trim();

  if (data.verdict === "one" || !name || foreign.length === 0) {
    tx(() => finishTask(task.id, task.run_id, usage, "done", data.reason || "One person."));
    return;
  }

  // Splitting out everything would mean the entry is misnamed, not conflated —
  // a different problem, and one this must not "fix" by emptying the entity.
  const total = (
    db().prepare("SELECT COUNT(*) AS n FROM live_mentions WHERE entity_id=?").get(entityId) as {
      n: number;
    }
  ).n;
  if (foreign.length >= total) {
    tx(() =>
      finishTask(
        task.id,
        task.run_id,
        usage,
        "skipped",
        `Left alone: the check wanted to move every passage out, which is a naming problem rather than a conflation.`
      )
    );
    return;
  }

  tx(() => {
    const norm = normalize(name, "person");
    const other = Number(
      db()
        .prepare(
          `INSERT INTO entities (type, canonical_name, normalized, disambiguator, entry_state)
           VALUES ('person', ?, ?, ?, 'none')`
        )
        .run(name, norm, data.other?.disambiguator?.trim() ?? null).lastInsertRowid
    );
    db()
      .prepare("INSERT OR IGNORE INTO aliases (entity_id, surface, normalized) VALUES (?, ?, ?)")
      .run(other, name, norm);

    const move = db().prepare("UPDATE mentions SET entity_id=? WHERE id=?");
    for (const id of foreign) move.run(other, id);

    // Relations and events follow the evidence they were drawn from.
    const placeholders = foreign.map(() => "?").join(",");
    db()
      .prepare(`UPDATE relations SET from_entity=? WHERE mention_id IN (${placeholders})`)
      .run(other, ...foreign);
    db()
      .prepare(`UPDATE events SET entity_id=? WHERE mention_id IN (${placeholders})`)
      .run(other, ...foreign);

    // Without this the next resolution pass would look at two people with
    // nearly identical names and helpfully put them back together.
    const kept = db().prepare("SELECT normalized FROM entities WHERE id=?").get(entityId) as {
      normalized: string;
    };
    const [a, b] = [kept.normalized, norm].sort();
    db()
      .prepare(
        "INSERT OR REPLACE INTO resolution_verdicts (type, a_norm, b_norm, same) VALUES ('person', ?, ?, 0)"
      )
      .run(a, b);

    // Both entries were built from evidence that has just changed.
    db()
      .prepare("UPDATE entities SET entry_state='stale' WHERE id IN (?, ?)")
      .run(entityId, other);
    enqueue(task.run_id, [
      { kind: "entry" as const, payload: { entityId, force: true } },
      { kind: "entry" as const, payload: { entityId: other } },
    ]);

    finishTask(
      task.id,
      task.run_id,
      usage,
      "done",
      `Separated ${foreign.length} passage(s) into "${name}" — ${data.reason ?? "different person"}.`
    );
  });
}
