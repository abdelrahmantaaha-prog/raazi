import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { finishTask } from "../queue";
import { addSourceTag, ensureTag, listTags } from "../tags";
import type { Task } from "../types";

/**
 * Files a new source under the research topics it belongs to.
 *
 * Runs as an ordinary queue task ahead of extraction, so it is paced, billed
 * and resumable like every other call — and so a source that arrives while the
 * key is out of quota still gets filed when the run picks back up.
 *
 * It is told the tags you already use and asked to prefer them. Left to itself
 * a model will happily coin "Egyptian History", "History of Egypt" and
 * "Modern Egypt" for three books on one shelf.
 */

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    existing: {
      type: Type.ARRAY,
      description: "Names of tags from the supplied list that fit this source. Prefer these.",
      items: { type: Type.STRING },
    },
    proposed: {
      type: Type.ARRAY,
      description:
        "New tags, only when nothing in the list fits. At most two, each a short topic name.",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          description: { type: Type.STRING },
        },
        required: ["name"],
      },
    },
  },
  required: ["existing", "proposed"],
};

const SYSTEM = `You file sources onto the right shelves in a researcher's library.

You are given a source and the list of topics they already work on. Choose the
topics this source belongs to.

- Strongly prefer tags from the existing list. Proposing a near-duplicate of one
  that already exists ("Egyptian History" when "Egypt" exists) is the main way
  this goes wrong.
- Only propose a new tag when the source genuinely belongs to a topic not in the
  list at all.
- A source may fit more than one topic, but two is usually plenty. Do not tag a
  source with a topic it merely mentions in passing.
- Name topics the way a researcher labels a shelf: short, concrete, a subject
  rather than a sentence.`;

export async function handleTag(task: Task): Promise<void> {
  const { sourceId } = JSON.parse(task.payload_json) as { sourceId: number };

  const source = db().prepare("SELECT * FROM sources WHERE id=?").get(sourceId) as
    | { id: number; title: string; author: string | null; tagged_at: string | null }
    | undefined;
  if (!source) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Source is gone.");
    return;
  }

  // You may have filed it yourself while it sat in the queue.
  const already = db()
    .prepare("SELECT COUNT(*) AS n FROM source_tags WHERE source_id=?")
    .get(sourceId) as { n: number };
  if (already.n > 0) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Already filed.");
    return;
  }

  // The opening of a book says what it is about far more cheaply than all of it.
  const sample = (
    db()
      .prepare("SELECT text FROM chunks WHERE source_id=? ORDER BY seq LIMIT 3")
      .all(sourceId) as { text: string }[]
  )
    .map((c) => c.text.slice(0, 1500))
    .join("\n\n---\n\n");

  if (!sample.trim()) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "No text to judge from yet.");
    return;
  }

  const known = listTags();
  const knownList = known.length
    ? known.map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ""}`).join("\n")
    : "(none yet — this is the first source)";

  const { data, usage } = await generateJson<{
    existing: string[];
    proposed: { name: string; description?: string }[];
  }>({
    stage: "tag",
    system: SYSTEM,
    schema: SCHEMA,
    parts: [
      `TOPICS ALREADY IN USE:\n${knownList}\n\nSOURCE: "${source.title}"${
        source.author ? ` by ${source.author}` : ""
      }\n\nOPENING:\n"""\n${sample}\n"""`,
    ],
  });

  const byName = new Map(known.map((t) => [t.name.toLowerCase(), t.id]));
  const applied: string[] = [];

  tx(() => {
    for (const name of data.existing ?? []) {
      const id = byName.get(name.trim().toLowerCase());
      if (id) {
        addSourceTag(sourceId, id, "ai");
        applied.push(name.trim());
      }
    }
    // Cap new tags, or a mixed library sprouts a tag per source.
    for (const p of (data.proposed ?? []).slice(0, 2)) {
      if (!p.name?.trim()) continue;
      if (byName.has(p.name.trim().toLowerCase())) continue;
      const id = ensureTag(p.name, p.description);
      addSourceTag(sourceId, id, "ai");
      applied.push(p.name.trim());
    }

    db().prepare("UPDATE sources SET tagged_at=datetime('now') WHERE id=?").run(sourceId);
    finishTask(
      task.id,
      task.run_id,
      usage,
      "done",
      applied.length ? `Filed under ${applied.join(", ")}.` : "No topic matched; left unfiled."
    );
  });
}
