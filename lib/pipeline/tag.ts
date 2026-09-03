import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { finishTask } from "../queue";
import { normalize, trigramSimilarity } from "../normalize";
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
          description: {
            type: Type.STRING,
            description:
              "One line: what belongs under it, opening with its facet — 'Region:', 'Theme:', 'Actor:' or 'Story:'.",
          },
        },
        required: ["name"],
      },
    },
  },
  required: ["existing", "proposed"],
};

const SYSTEM = `You file sources onto the right shelves in a journalist's library.

You are given a source and the list of topics they already work on. Choose the
topics this source belongs to.

- Strongly prefer tags from the existing list. Proposing a near-duplicate of one
  that already exists ("Egyptian History" when "Egypt" exists) is the main way
  this goes wrong.
- Only propose a new tag when the source genuinely belongs to a topic not in the
  list at all.
- A beat is filed on more than one axis. Where they apply, choose one REGION
  tag (a country or area: "Canada", "Gulf states"), one THEME tag (a subject:
  "Trade policy", "Elections"), and one ACTOR or STORY tag (a body, an
  administration, or a named running story: "Trudeau government", "USMCA
  review"). Not every source has all three, and three is plenty. Never invent
  a tag to fill a slot, and do not tag a source with a topic it merely
  mentions in passing.
- Name topics the way a researcher labels a shelf: short, concrete, a subject
  rather than a sentence.`;

/** Chunks looked at before giving up on finding prose. */
const LOOKAHEAD = 12;
/** Substantive chunks shown, and characters of each. */
const SAMPLE_CHUNKS = 3;
const SAMPLE_CHARS = 1500;

export async function handleTag(task: Task): Promise<void> {
  const { sourceId } = JSON.parse(task.payload_json) as { sourceId: number };

  const source = db()
    .prepare(
      "SELECT id, title, author, outlet, publisher, published_at, year, kind, tagged_at FROM sources WHERE id=?"
    )
    .get(sourceId) as
    | {
        id: number;
        title: string;
        author: string | null;
        outlet: string | null;
        publisher: string | null;
        published_at: string | null;
        year: string | null;
        kind: string;
        tagged_at: string | null;
      }
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

  const sample = sampleFor(sourceId);

  if (!sample.trim()) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "No text to judge from yet.");
    return;
  }

  const known = listTags();
  const knownList = known.length
    ? known.map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ""}`).join("\n")
    : "(none yet — this is the first source)";

  const byline = [
    source.author ? `by ${source.author}` : "",
    source.outlet ?? source.publisher ?? "",
    (source.published_at ?? source.year ?? "").slice(0, 10),
  ]
    .filter(Boolean)
    .join(", ");

  const { data, usage } = await generateJson<{
    existing: string[];
    proposed: { name: string; description?: string }[];
  }>({
    stage: "tag",
    system: SYSTEM,
    schema: SCHEMA,
    parts: [
      `TOPICS ALREADY IN USE:\n${knownList}\n\nSOURCE: "${source.title}"${
        byline ? ` (${byline})` : ""
      }\n\nOPENING:\n"""\n${sample}\n"""`,
    ],
  });

  const applied: string[] = [];

  tx(() => {
    const filed = new Set<number>();
    for (const name of data.existing ?? []) {
      const id = matchTag(name, known);
      if (id && !filed.has(id)) {
        addSourceTag(sourceId, id, "ai");
        filed.add(id);
        applied.push(name.trim());
      }
    }
    // Cap new tags, or a mixed library sprouts a tag per source.
    for (const p of (data.proposed ?? []).slice(0, 2)) {
      if (!p.name?.trim()) continue;
      // A "new" tag that is a near-miss on an old one is the old one.
      const existingId = matchTag(p.name, known);
      const id = existingId ?? ensureTag(p.name, p.description);
      if (filed.has(id)) continue;
      addSourceTag(sourceId, id, "ai");
      filed.add(id);
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

/**
 * The text the filer judges from: the first substantive passages, skipping
 * front matter.
 *
 * The opening of a book says what it is about far more cheaply than all of it
 * — but the opening of an EPUB or a scanned PDF is the copyright page and the
 * table of contents, which say what the publisher is. So the first dozen
 * passages are screened and the first three that read as prose are used.
 */
export function sampleFor(sourceId: number): string {
  const rows = db()
    .prepare("SELECT text FROM chunks WHERE source_id=? ORDER BY seq LIMIT ?")
    .all(sourceId, LOOKAHEAD) as { text: string }[];
  const substantive = rows.filter((c) => !looksLikeFrontMatter(c.text));
  const chosen = (substantive.length ? substantive : rows).slice(0, SAMPLE_CHUNKS);
  return chosen.map((c) => c.text.slice(0, SAMPLE_CHARS)).join("\n\n---\n\n");
}

const FRONT_MATTER: RegExp[] = [
  /\bcopyright\b/i,
  /©/,
  /\ball rights reserved\b/i,
  /\bisbn\b/i,
  /\blibrary of congress\b/i,
  /\bcataloguing[- ]in[- ]publication\b|\bcataloging[- ]in[- ]publication\b/i,
  /\bfirst published\b|\bfirst edition\b|\bthis edition\b/i,
  /\bpublished by\b|\bprinted in\b|\bprinted and bound\b/i,
  /\btable of contents\b|^\s*contents\s*$/im,
  /\backnowledg(?:e)?ments\b/i,
  /\balso by\b|\bby the same author\b/i,
  /\btypeset\b|\bcover design\b|\bcover image\b/i,
  /\bno part of this (?:book|publication)\b/i,
  /\bwithout (?:the )?(?:prior )?(?:written )?permission\b/i,
];

/**
 * Whether a passage is apparatus rather than the work: a copyright page, a
 * contents list, a dedication. Two publishing phrases, or a page that is
 * mostly short numbered lines, or almost no sentences at all.
 */
export function looksLikeFrontMatter(text: string): boolean {
  const head = text.slice(0, 2500);
  const hits = FRONT_MATTER.filter((re) => re.test(head)).length;
  if (hits >= 2) return true;

  const lines = head
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length >= 8) {
    const short = lines.filter((l) => l.length < 60).length;
    const numbered = lines.filter((l) => /\d+\s*$/.test(l) || /^(?:chapter|part)\s+\S+/i.test(l)).length;
    if (short / lines.length > 0.8 && numbered / lines.length > 0.4) return true;
  }

  const sentences = (head.match(/[.!?؟]["'”’)]*\s/g) ?? []).length;
  if (head.length > 800 && sentences < 3) return true;
  return false;
}

/**
 * The known tag a returned name refers to, if any.
 *
 * Exact lower-case equality was the only match, so "Egypt (modern)" against an
 * existing "Egypt", or "U.S. Politics" against "US Politics", was silently
 * dropped and the source left unfiled. Names now meet through the same
 * normaliser entities use, then a spacing-blind form, then with a trailing
 * qualifier in brackets removed, then a trigram score high enough to catch a
 * doubled letter but not a different topic.
 */
export function matchTag(name: string, known: { id: number; name: string }[]): number | undefined {
  const wanted = normalize(name);
  if (!wanted) return undefined;
  const squash = (s: string) => s.replace(/\s+/g, "");
  const unqualified = normalize(name.replace(/\s*\([^)]*\)\s*$/, ""));

  const exact = known.find((t) => normalize(t.name) === wanted);
  if (exact) return exact.id;

  const spaced = known.find((t) => squash(normalize(t.name)) === squash(wanted));
  if (spaced) return spaced.id;

  if (unqualified && unqualified !== wanted) {
    const bare = known.find((t) => normalize(t.name) === unqualified);
    if (bare) return bare.id;
  }

  let best: { id: number; score: number } | undefined;
  for (const t of known) {
    const score = trigramSimilarity(normalize(t.name), wanted);
    if (score >= TAG_SIMILARITY && (!best || score > best.score)) best = { id: t.id, score };
  }
  return best?.id;
}

const TAG_SIMILARITY = 0.85;
