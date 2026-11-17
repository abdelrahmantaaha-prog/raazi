import { Type, type Schema } from "@google/genai";
import { db, tx } from "./db";
import { generateJson } from "./ai/client";
import { getConfig } from "./config";
import { isLiteModel } from "./keys";
import { modelsFor } from "./providers";
import { applyGroups, heldAccounts, headlineLines, pairsFromModel } from "./inbox-groups";
import { IMPORTANCE, type Importance } from "./importance";

/**
 * Bundles: the subject level of the inbox, and the event pass inside it.
 *
 * See lib/db/migrate-bundles.ts for why the level exists. This module asks
 * the cheapest model to sort every headline waiting in the inbox into
 * subject bundles — one call, headlines only — and then, bundle by bundle,
 * which headlines inside are accounts of one event. The second question is
 * the one the whole-inbox pass answered badly: asked about five hundred
 * headlines at once, a small model finds three pairs; asked about the
 * twenty in one bundle, it finds the ones that are there.
 */

const BUNDLE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    bundles: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING, description: "The subject in two to five words, as a reporter would say it." },
          ids: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Every id that belongs to this subject." },
        },
        required: ["label", "ids"],
      },
    },
  },
  required: ["bundles"],
};

const BUNDLE_SYSTEM = `You sort the headlines waiting in a political journalist's inbox into bundles by
subject, so that a whole subject can be read, kept or discarded at once. You see
only headlines, each with an outlet and a time; some lines are stories that
already have several accounts.

- A bundle is a SUBJECT a reporter would triage together: a running story
  ("Iran war costs", "Supreme Court on mail ballots"), a beat ("AI regulation in
  Congress", "Canada–US trade"), an episode ("Quebec election debate"). Name it
  the way a desk would.
- Every id goes in exactly one bundle. Aim for bundles of four to twenty-five;
  split a subject that would be bigger into its natural parts.
- When no running story fits, the beat is the bundle: "Canadian politics",
  "US Congress", "Middle East", "Europe", "Business and markets", "Technology
  and AI", "Culture and sport". Only what fits no story and no beat goes into
  "Everything else", and that should be a small bundle — if it holds a fifth of
  the ids, you have not sorted them.
- Reuse an EXISTING LABEL whenever the subject is the same, so the bundles keep
  their names from one morning to the next. Coin a new label only for a new
  subject.
- Return ids exactly as given.`;

export interface BundleResult {
  items: number;
  bundles: number;
  assigned: number;
  model: string | null;
  error: string | null;
}

interface HeldItemLine {
  itemId: number;
  sourceId: number;
  storyId: number | null;
  title: string;
  outlet: string;
  at: string;
  bundle: string | null;
}

function heldItemLines(): HeldItemLine[] {
  return db()
    .prepare(
      `SELECT i.id AS itemId, s.id AS sourceId, ss.story_id AS storyId, i.title,
              COALESCE(s.outlet, f.outlet, f.title) AS outlet,
              COALESCE(i.published_at, s.published_at, i.seen_at) AS at,
              b.label AS bundle
         FROM feed_items i
         JOIN feeds f ON f.id = i.feed_id
         JOIN sources s ON s.id = i.source_id
    LEFT JOIN story_sources ss ON ss.source_id = s.id
    LEFT JOIN inbox_bundle_items bi ON bi.item_id = i.id
    LEFT JOIN inbox_bundles b ON b.id = bi.bundle_id
        WHERE i.state = 'held' AND i.decided_at IS NULL
        ORDER BY at, i.id`
    )
    .all() as HeldItemLine[];
}

/**
 * The lines the model sorts: one per story with several held accounts, one
 * per lone item. Fewer lines than items, and a story's accounts travel
 * together into whatever bundle the story lands in.
 */
export function bundleLines(items: HeldItemLine[]): { lines: string[]; membersOf: Map<string, number[]> } {
  const byStory = new Map<number, HeldItemLine[]>();
  for (const it of items) if (it.storyId !== null) byStory.set(it.storyId, [...(byStory.get(it.storyId) ?? []), it]);
  const when = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(5, 16).replace("T", " ");
  };
  const lines: string[] = [];
  const membersOf = new Map<string, number[]>();
  const seen = new Set<number>();
  for (const it of items) {
    const mates = it.storyId !== null ? byStory.get(it.storyId) ?? [] : [];
    const title = it.title.replace(/\s+/g, " ").trim();
    const current = mates.find((m) => m.bundle)?.bundle ?? it.bundle;
    const now = current ? ` [now: ${current}]` : "";
    if (it.storyId !== null && mates.length > 1) {
      if (seen.has(it.storyId)) continue;
      seen.add(it.storyId);
      const id = `S${it.storyId}`;
      membersOf.set(id, mates.map((m) => m.itemId));
      lines.push(`${id}: ${title} — ${mates.length} accounts, ${when(it.at)}${now}`);
    } else {
      const id = `I${it.itemId}`;
      membersOf.set(id, [it.itemId]);
      lines.push(`${id}: ${title} — ${it.outlet}, ${when(it.at)}${now}`);
    }
  }
  return { lines, membersOf };
}

/** Which items go where, after the guards. Pure. */
export function assignmentsFromModel(
  membersOf: Map<string, number[]>,
  bundles: { label?: string; ids?: string[] }[]
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const taken = new Set<number>();
  for (const b of bundles ?? []) {
    const label = (b.label ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!label) continue;
    const items: number[] = [];
    for (const raw of b.ids ?? []) {
      const members = membersOf.get(String(raw).trim());
      if (!members) continue;
      for (const id of members) {
        if (taken.has(id)) continue;
        taken.add(id);
        items.push(id);
      }
    }
    if (!items.length) continue;
    out.set(label, [...(out.get(label) ?? []), ...items]);
  }
  return out;
}

/** How many headlines one bundling call is given. Past this a small model stops sorting and starts shrugging. */
const BUNDLE_CHUNK = 150;
/** If more than this share of a chunk lands in "Everything else", the chunk is asked again of a real model. */
const UNSORTED_LIMIT = 0.4;
const LEFTOVER = "Everything else";

/** The cheapest model on the provider's ring that is not a lite one, for the retry. */
function cheapestRealModel(): string | undefined {
  const routed = getConfig().routing?.group ?? "gemini";
  if (routed !== "gemini") return undefined;
  return modelsFor("gemini").filter((m) => !isLiteModel(m)).pop();
}

/**
 * Sorts the inbox into bundles. Never throws; says what happened.
 *
 * In chunks, oldest first, each chunk told the labels the ones before it
 * made, so a subject that runs across the week keeps one name. The lite
 * model asked about five hundred headlines at once put 184 of the first
 * 200 into "Everything else"; asked about 150 it sorts them, and a chunk it
 * still leaves mostly unsorted is put once more to the cheapest model that
 * is not lite.
 */
export async function bundleInbox(opts: { timeoutMs?: number; chunk?: number } = {}): Promise<BundleResult> {
  const items = heldItemLines();
  const nothing: BundleResult = { items: items.length, bundles: 0, assigned: 0, model: null, error: null };
  if (items.length < 4) return nothing;
  const { lines, membersOf } = bundleLines(items);
  const labels = new Set(
    (db().prepare("SELECT label FROM inbox_bundles ORDER BY label").all() as { label: string }[]).map((r) => r.label)
  );
  const chunk = Math.max(20, opts.chunk ?? BUNDLE_CHUNK);
  const assignments = new Map<string, number[]>();
  const models = new Set<string>();
  let error: string | null = null;

  const ask = async (part: string[], model?: string) => {
    const res = await generateJson<{ bundles?: { label?: string; ids?: string[] }[] }>({
      stage: "group",
      system: BUNDLE_SYSTEM,
      schema: BUNDLE_SCHEMA,
      temperature: 0,
      timeoutMs: opts.timeoutMs ?? 180_000,
      ...(model ? { model } : {}),
      parts: [
        labels.size ? `EXISTING LABELS (reuse these where they fit): ${[...labels].sort().join(" | ")}` : "EXISTING LABELS: (none yet)",
        `HEADLINES (${part.length}), oldest first:\n${part.join("\n")}`,
      ],
    });
    if (res.model) models.add(res.model);
    return assignmentsFromModel(membersOf, res.data.bundles ?? []);
  };
  // Unsorted is what came back under "Everything else" AND what did not
  // come back at all: the lite model's habit is to answer for sixty of a
  // hundred and fifty and say nothing about the rest.
  const unsortedShare = (a: Map<string, number[]>, part: string[]) => {
    const total = part.reduce((n, l) => n + (membersOf.get(l.split(":")[0])?.length ?? 0), 0);
    const sorted = [...a.entries()].filter(([label]) => !/^everything else$/i.test(label)).reduce((n, [, ids]) => n + ids.length, 0);
    return total ? 1 - sorted / total : 0;
  };

  for (let i = 0; i < lines.length; i += chunk) {
    const part = lines.slice(i, i + chunk);
    try {
      let got = await ask(part);
      const retry = cheapestRealModel();
      if (retry && unsortedShare(got, part) > UNSORTED_LIMIT) {
        console.log(`[corpus] inbox: a chunk of ${part.length} came back mostly unsorted; asking ${retry}`);
        const again = await ask(part, retry);
        if (unsortedShare(again, part) < unsortedShare(got, part)) got = again;
      }
      for (const [label, ids] of got) {
        const name = /^everything else$/i.test(label) ? LEFTOVER : label;
        assignments.set(name, [...(assignments.get(name) ?? []), ...ids]);
        if (name !== LEFTOVER) labels.add(name);
      }
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      console.warn(`[corpus] inbox: the model could not bundle headlines — ${error}`);
      break;
    }
  }
  // What no chunk placed goes once more, on its own, to the cheapest real
  // model: a lite model's leftovers are mostly things it did not get to,
  // not things that fit nowhere.
  if (!error) {
    const placed = new Set([...assignments.entries()].filter(([l]) => l !== LEFTOVER).flatMap(([, ids]) => ids));
    const loose = lines.filter((l) => !(membersOf.get(l.split(":")[0]) ?? []).every((id) => placed.has(id)));
    const retry = cheapestRealModel();
    if (loose.length >= 8) {
      try {
        const got = await ask(loose, retry);
        for (const [label, ids] of got) {
          const name = /^everything else$/i.test(label) ? LEFTOVER : label;
          const fresh = ids.filter((id) => !placed.has(id));
          if (!fresh.length) continue;
          assignments.set(name, [...(assignments.get(name) ?? []), ...fresh]);
          if (name !== LEFTOVER) labels.add(name);
        }
      } catch (err) {
        console.warn(`[corpus] inbox: the leftover pass failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (!assignments.size) return { ...nothing, error, model: [...models].join(", ") || null };

  // A bundle past BIG_SUBJECT is a beat, not a subject: chunk after chunk
  // reuses its label, and "Trump administration" had 813 headlines by 17
  // November 2026 — the arch, the seafood strategy and the chief of staff
  // read as one pile. Each is put back to the model alone, to be split into
  // the subjects inside it.
  if (!error) {
    const lineOf = new Map<number, string>();
    for (const l of lines) for (const id of membersOf.get(l.split(":")[0]) ?? []) lineOf.set(id, l);
    for (const [label, ids] of [...assignments.entries()]) {
      if (label === LEFTOVER || ids.length <= BIG_SUBJECT) continue;
      const part = [...new Set(ids.map((id) => lineOf.get(id)).filter((l): l is string => !!l))];
      try {
        const parts = await splitSubject(label, part, membersOf, labels, opts.timeoutMs, cheapestRealModel());
        if (parts.model) models.add(parts.model);
        if (parts.split.size < 2) continue;
        const moved = new Set([...parts.split.values()].flat());
        const rest = ids.filter((id) => !moved.has(id));
        if (rest.length) assignments.set(label, rest);
        else assignments.delete(label);
        for (const [sub, subIds] of parts.split) {
          assignments.set(sub, [...(assignments.get(sub) ?? []).filter((id) => !moved.has(id)), ...subIds]);
          labels.add(sub);
        }
        console.log(`[corpus] inbox: split "${label}" (${ids.length}) into ${parts.split.size} subjects`);
      } catch (err) {
        console.warn(`[corpus] inbox: could not split "${label}" — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return tx(() => {
    const find = db().prepare("SELECT id FROM inbox_bundles WHERE label = ?");
    const make = db().prepare("INSERT INTO inbox_bundles (label) VALUES (?)");
    const put = db().prepare(
      `INSERT INTO inbox_bundle_items (item_id, bundle_id, assigned_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(item_id) DO UPDATE SET bundle_id = excluded.bundle_id, assigned_at = excluded.assigned_at`
    );
    let assigned = 0;
    // An item a chunk called leftover and the leftover pass then homed is
    // homed; only what nothing placed is taken out of its old bundle.
    const homed = new Set([...assignments.entries()].filter(([l]) => l !== LEFTOVER).flatMap(([, ids]) => ids));
    for (const [label, ids] of assignments) {
      // What fits nowhere is left unbundled rather than filed under a label
      // that says so; the inbox shows it as "Everything else" itself.
      if (label === LEFTOVER) {
        const out = ids.filter((id) => !homed.has(id));
        if (out.length) db().prepare(`DELETE FROM inbox_bundle_items WHERE item_id IN (${out.map(() => "?").join(",")})`).run(...out);
        continue;
      }
      const row = find.get(label) as { id: number } | undefined;
      const bundleId = row?.id ?? Number(make.run(label).lastInsertRowid);
      db().prepare("UPDATE inbox_bundles SET updated_at = datetime('now') WHERE id = ?").run(bundleId);
      for (const id of ids) {
        put.run(id, bundleId);
        assigned++;
      }
    }
    db()
      .prepare(
        `DELETE FROM inbox_bundles WHERE id NOT IN (
           SELECT bi.bundle_id FROM inbox_bundle_items bi
             JOIN feed_items i ON i.id = bi.item_id
            WHERE i.state = 'held' AND i.decided_at IS NULL)`
      )
      .run();
    const bundles = (db().prepare("SELECT COUNT(*) AS n FROM inbox_bundles").get() as { n: number }).n;
    const model = [...models].join(", ") || null;
    if (assigned) console.log(`[corpus] inbox: ${assigned} item(s) sorted into ${bundles} bundle(s) by ${model ?? "the model"}`);
    return { items: items.length, bundles, assigned, model, error };
  });
}


/** Past this many headlines a bundle is put back to be split into its subjects. */
export const BIG_SUBJECT = 60;

const SPLIT_SYSTEM = `These headlines from a political journalist's inbox were all filed under one
broad heading, and it is too broad to triage. Split them into the specific
subjects inside it, the way a desk would: a running story, a fight, a policy,
a person's troubles — "Trump's triumphal arch", "Seafood labelling order",
"White House chief of staff change".

- Aim for subjects of four to twenty-five headlines. Every headline that has
  no subject of its own goes in "Everything else".
- Name each subject in two to five specific words. Never reuse the broad
  heading itself, and do not invent new broad headings ("Politics", "Trump").
- Reuse an EXISTING LABEL when it names the same subject.
- Return ids exactly as given.`;

/**
 * Splits one over-broad bundle into the subjects inside it. In chunks of
 * BUNDLE_CHUNK, each told the labels the ones before made. What the model
 * calls "Everything else", or leaves out, stays under the broad heading.
 * Pure apart from the model call; never throws past the caller's catch.
 */
async function splitSubject(
  broad: string,
  part: string[],
  membersOf: Map<string, number[]>,
  existing: Set<string>,
  timeoutMs: number | undefined,
  model: string | undefined
): Promise<{ split: Map<string, number[]>; model: string | null }> {
  const split = new Map<string, number[]>();
  const known = new Set([...existing].filter((l) => l !== broad));
  let used: string | null = null;
  for (let i = 0; i < part.length; i += BUNDLE_CHUNK) {
    const chunk = part.slice(i, i + BUNDLE_CHUNK);
    const res = await generateJson<{ bundles?: { label?: string; ids?: string[] }[] }>({
      stage: "group",
      system: SPLIT_SYSTEM,
      schema: BUNDLE_SCHEMA,
      temperature: 0,
      timeoutMs: timeoutMs ?? 180_000,
      ...(model ? { model } : {}),
      parts: [
        `BROAD HEADING: ${broad}`,
        known.size ? `EXISTING LABELS: ${[...known].sort().join(" | ")}` : "EXISTING LABELS: (none)",
        `HEADLINES (${chunk.length}), oldest first:\n${chunk.join("\n")}`,
      ],
    });
    used = res.model ?? used;
    for (const [label, ids] of assignmentsFromModel(membersOf, res.data.bundles ?? [])) {
      if (/^everything else$/i.test(label) || label.toLowerCase() === broad.toLowerCase()) continue;
      split.set(label, [...(split.get(label) ?? []), ...ids]);
      known.add(label);
    }
  }
  // A "subject" of one headline is a headline; it stays under the heading.
  for (const [label, ids] of split) if (ids.length < 2) split.delete(label);
  return { split, model: used };
}

export interface BundleEventResult {
  bundles: number;
  asked: number;
  grouped: number;
  stories: number;
  folded: number;
  errors: number;
  model: string | null;
}

/** How many bundles are asked about at once. */
const EVENT_CONCURRENCY = 4;
/** A bundle with this many lines is put to the cheapest real model rather than a lite one. */
const BIG_BUNDLE = 15;

/**
 * Inside each bundle, which headlines are one event. One small call per
 * bundle with three or more lines, a few at a time.
 */
export async function groupEventsInBundles(opts: { timeoutMs?: number } = {}): Promise<BundleEventResult> {
  const bundles = db().prepare("SELECT id, label FROM inbox_bundles ORDER BY id").all() as { id: number; label: string }[];
  const result: BundleEventResult = { bundles: bundles.length, asked: 0, grouped: 0, stories: 0, folded: 0, errors: 0, model: null };

  const one = async (b: { id: number; label: string }) => {
    const accounts = heldAccounts(b.id);
    const { lines, storyRep } = headlineLines(accounts);
    if (lines.length < 3) return;
    result.asked++;
    // A big bundle is the lite model's weak spot; the cheapest real model
    // reads twenty headlines as easily as five.
    const model = lines.length >= BIG_BUNDLE ? cheapestRealModel() : undefined;
    try {
      const res = await generateJson<{ groups?: { label?: string; ids?: string[] }[] }>({
        stage: "group",
        system: EVENT_SYSTEM,
        schema: EVENT_SCHEMA,
        temperature: 0,
        timeoutMs: opts.timeoutMs ?? 90_000,
        ...(model ? { model } : {}),
        parts: [`SUBJECT: ${b.label}\nHEADLINES (${lines.length}), oldest first:\n${lines.join("\n")}`],
      });
      result.model = res.model ?? result.model;
      const { pairs } = pairsFromModel(accounts, storyRep, res.data.groups ?? []);
      const applied = applyGroups(accounts, pairs);
      result.grouped += applied.grouped;
      result.stories += applied.stories;
      result.folded += applied.folded;
    } catch (err) {
      result.errors++;
      console.warn(`[corpus] inbox: the model could not group "${b.label}" — ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const queue = [...bundles];
  await Promise.all(
    Array.from({ length: Math.min(EVENT_CONCURRENCY, queue.length) }, async () => {
      for (let b = queue.shift(); b; b = queue.shift()) await one(b);
    })
  );
  return result;
}

const EVENT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    groups: {
      type: Type.ARRAY,
      description: "Sets of headlines that report one event. Leave out anything that stands alone.",
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING, description: "The event in a few words." },
          ids: { type: Type.ARRAY, items: { type: Type.STRING }, description: "The ids of the headlines, at least two." },
        },
        required: ["ids"],
      },
    },
  },
  required: ["groups"],
};

const EVENT_SYSTEM = `These headlines are all on one subject. Say which of them are accounts of the
SAME EVENT — the same ruling, hearing, announcement, report, vote or statement —
so that a journalist reads each event once.

- Several outlets on one thing, a same-day follow-up, a reaction piece to it:
  one group.
- The same subject is not the same event. Two pieces on the subject that report
  different things stay apart. When in doubt, leave them apart.
- Ids beginning with S are stories already formed; attach a lone headline to one
  when it is the same event. Never put two S ids in one group.
- Leave out everything that stands alone. An empty list is a fine answer.
- Return ids exactly as given.`;

const RATE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: Object.fromEntries(
    IMPORTANCE.map((level) => [level, { type: Type.ARRAY, items: { type: Type.STRING }, description: `The ids that are ${level}.` }])
  ),
  required: [...IMPORTANCE],
};

const RATE_SYSTEM = `You rate the headlines waiting in a political journalist's inbox by how much
they matter, so the most important are read first. You see only headlines, each
with an outlet or a count of accounts, a time, and sometimes the subject it was
filed under. Put every id in exactly one of four lists:

- breaking: happening now or in the last hours, and big — an attack, a leader's
  death or resignation, a war escalating, an election result, a major ruling or
  decision just out. A desk would drop everything. Rare: a few in a hundred.
- high: significant news on a subject that matters — a consequential decision,
  vote, policy, deal, investigation or report; a major development in a running
  story. Several outlets on one thing usually means at least high.
- medium: routine news — incremental updates, reactions, statements, smaller or
  local stories, scheduled events going as expected.
- evergreen: not tied to the day — analysis, explainers, features, profiles,
  opinion, interviews, history. It would read the same next week.

Judge by what the headline reports, not how it is worded; an alarming headline
on a minor matter is medium. Use the NOW time to judge what is breaking — an old
item is not breaking however big it was. Return ids exactly as given.`;

/** Which item gets which stage, after the guards. An id named twice keeps the more important stage. Pure. */
export function ratingsFromModel(
  membersOf: Map<string, number[]>,
  answer: Partial<Record<Importance, string[]>>
): Map<number, Importance> {
  const out = new Map<number, Importance>();
  for (const level of IMPORTANCE) {
    for (const raw of answer?.[level] ?? []) {
      for (const id of membersOf.get(String(raw).trim()) ?? []) if (!out.has(id)) out.set(id, level);
    }
  }
  return out;
}

export interface RateResult {
  asked: number;
  rated: number;
  model: string | null;
  error: string | null;
}

/**
 * Gives every unrated item in the inbox its stage. Never throws; says what
 * happened.
 *
 * Each item is rated once, when it is first seen, so pressing Group related
 * again costs nothing for what is already rated. Headlines only, in chunks,
 * on the cheap grouping model; a story's accounts travel as one line and get
 * one stage. What the model leaves out stays unrated and is asked again next
 * time.
 */
export async function rateInbox(opts: { timeoutMs?: number; chunk?: number } = {}): Promise<RateResult> {
  const items = db()
    .prepare(
      `SELECT i.id AS itemId, s.id AS sourceId, ss.story_id AS storyId, i.title,
              COALESCE(s.outlet, f.outlet, f.title) AS outlet,
              COALESCE(i.published_at, s.published_at, i.seen_at) AS at,
              b.label AS bundle
         FROM feed_items i
         JOIN feeds f ON f.id = i.feed_id
         JOIN sources s ON s.id = i.source_id
    LEFT JOIN story_sources ss ON ss.source_id = s.id
    LEFT JOIN inbox_bundle_items bi ON bi.item_id = i.id
    LEFT JOIN inbox_bundles b ON b.id = bi.bundle_id
        WHERE i.state = 'held' AND i.decided_at IS NULL AND i.importance IS NULL
        ORDER BY at, i.id`
    )
    .all() as HeldItemLine[];
  const result: RateResult = { asked: items.length, rated: 0, model: null, error: null };
  if (!items.length) return result;
  const { lines, membersOf } = bundleLines(items);
  const chunk = Math.max(20, opts.chunk ?? BUNDLE_CHUNK);
  const models = new Set<string>();
  const put = db().prepare("UPDATE feed_items SET importance = ?, importance_at = datetime('now') WHERE id = ? AND importance IS NULL");
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  for (let i = 0; i < lines.length; i += chunk) {
    const part = lines.slice(i, i + chunk);
    try {
      const res = await generateJson<Partial<Record<Importance, string[]>>>({
        stage: "group",
        system: RATE_SYSTEM,
        schema: RATE_SCHEMA,
        temperature: 0,
        timeoutMs: opts.timeoutMs ?? 120_000,
        parts: [`NOW: ${now} UTC\nHEADLINES (${part.length}), oldest first:\n${part.join("\n")}`],
      });
      if (res.model) models.add(res.model);
      const ratings = ratingsFromModel(membersOf, res.data);
      tx(() => {
        for (const [id, level] of ratings) result.rated += put.run(level, id).changes;
      });
    } catch (err) {
      result.error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      console.warn(`[corpus] inbox: the model could not rate headlines — ${result.error}`);
      break;
    }
  }
  result.model = [...models].join(", ") || null;
  if (result.rated) console.log(`[corpus] inbox: ${result.rated} item(s) rated by ${result.model ?? "the model"}`);
  return result;
}

/** A bundle as the inbox shows it. */
export function listBundles(): { id: number; label: string; items: number }[] {
  return db()
    .prepare(
      `SELECT b.id, b.label,
              (SELECT COUNT(*) FROM inbox_bundle_items bi JOIN feed_items i ON i.id = bi.item_id
                WHERE bi.bundle_id = b.id AND i.state = 'held' AND i.decided_at IS NULL) AS items
         FROM inbox_bundles b ORDER BY items DESC, b.label`
    )
    .all() as { id: number; label: string; items: number }[];
}
