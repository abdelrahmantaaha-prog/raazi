import type Database from "better-sqlite3";
import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { embed, generateJson } from "../ai/client";
import {
  cosine,
  fromBlob,
  isSubsetName,
  normalize,
  toBlob,
  trigramOverlap,
  trigrams,
  trigramSimilarity,
} from "../normalize";
import { finishTask } from "../queue";
import type { EntityType, Task } from "../types";

/**
 * Second pass over an entity type once a source is indexed. Extraction only
 * matched names that were already identical; this is where "Nasser",
 * "Gamal Abdel Nasser" and "President Nasser" become one person — and where
 * two different Khans stay two different Khans.
 *
 * Idempotent on purpose: every verdict is cached in resolution_verdicts, so a
 * run killed mid-pass and restarted re-asks the model almost nothing.
 */

export interface Row {
  id: number;
  canonical_name: string;
  normalized: string;
  disambiguator: string | null;
  embedding: Buffer | null;
  mentions: number;
  /** Present when the pool spans kindred types; absent on the person pass. */
  type?: EntityType;
}

const AUTO_MERGE_TRIGRAM = 0.92;
const CANDIDATE_TRIGRAM = 0.5;
const CANDIDATE_COSINE = 0.86;
const BATCH = 10;

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    verdicts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          pair: { type: Type.INTEGER, description: "The pair number given in the prompt." },
          same: { type: Type.BOOLEAN },
          reason: { type: Type.STRING, description: "Under 15 words." },
        },
        required: ["pair", "same"],
      },
    },
  },
  required: ["verdicts"],
};

const SYSTEM = `You decide whether two names in a research corpus refer to the same
real entity. You are given the evidence sentences each name appears in.

Answer true only when the passages make it clear they are the same. A shared
surname, a shared first name, or merely a similar spelling is not enough — two
different people in one book often share a name, and wrongly fusing them corrupts
the record in a way that is hard to notice later. Each side carries the date
span of its evidence: two names whose evidence sits decades apart, or on
different sides of a change of office, are usually two people, and a span is a
reason to doubt, never on its own a reason to merge. When the evidence does not
settle it, answer false. A missed merge is a nuisance; a wrong merge is a lie.`;

/**
 * Types that describe the same kind of thing under different labels.
 *
 * Extraction picks one word for a collective body and picks a different one the
 * next time it meets it: "European Union" arrived as an org, an institution and
 * a place, and because this pass only ever compared entities of a single type,
 * the three were never in the room together. The result was two entries about
 * the same union, each written from a third of the evidence and neither aware of
 * the other.
 *
 * Only collective bodies are grouped. `person` is deliberately excluded: a firm
 * carrying its founder's name is the single most common trap in these sources —
 * a Bechtel who is a man and a Bechtel that is a company — and merging those
 * would corrupt exactly the distinction the entries exist to draw. `event` and
 * `work` are excluded for the same reason: Rana Plaza the building and Rana
 * Plaza the collapse are genuinely two things.
 *
 * Widening the pool only proposes the pair. The model still answers, under the
 * same conservative instruction, so a missed merge stays a nuisance and a wrong
 * merge stays unlikely.
 */
const KINDRED_TYPES: readonly EntityType[][] = [["org", "institution", "place"]];

function kindredOf(type: EntityType): readonly EntityType[] {
  return KINDRED_TYPES.find((g) => g.includes(type)) ?? [type];
}

export async function handleResolve(task: Task): Promise<void> {
  // A pass queued by an ingest names the source, and then only entities that
  // source touched are compared — against everything of the type, but not
  // each other's strangers. A pass with no source (Enhance, a manual re-run)
  // compares all against all as before. Comparing every entity of a type
  // against every other on every ingest is quadratic; at two thousand
  // entities it was fine and at a news feed's fifty thousand it is not.
  const { type, sourceId } = JSON.parse(task.payload_json) as { type: EntityType; sourceId?: number };

  // The pass is still owned by one type — it is enqueued per type, and running
  // the same comparison from all three would trigger it three times. So the
  // pool widens only for the first type of its group, which does the work for
  // the whole group.
  const kindred = kindredOf(type);
  const owns = kindred[0] === type;
  const pool = owns ? kindred : [type];
  const holes = pool.map(() => "?").join(",");

  let rows = db()
    .prepare(
      `SELECT e.id, e.canonical_name, e.normalized, e.disambiguator, e.embedding, e.type,
              (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id = e.id) AS mentions
         FROM entities e
        WHERE e.type IN (${holes}) AND e.merged_into IS NULL
        ORDER BY mentions DESC`
    )
    .all(...pool) as Row[];

  let tokensIn = 0;
  let tokensOut = 0;

  if (rows.length < 2) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "done");
    return;
  }

  if (type === "person") {
    foldBareNames(rows);
    // Anything folded above is gone; comparing it further would resurrect it.
    rows = rows.filter((r) => r.mentions > 0);
  }

  // --- candidate pairs, cheapest signals first -----------------------------
  const touched = sourceId ? touchedBy(sourceId, rows) : null;
  const inScope = (a: Row, b: Row) => !touched || touched.has(a.id) || touched.has(b.id);

  // Each name's trigrams once, not once per comparison: a pass over three
  // thousand people used to build eighteen million sets to compare.
  const grams = rows.map((r) => trigrams(r.normalized));
  const pairs: { a: Row; b: Row; trigram: number }[] = [];
  const breathe = breather();
  for (let i = 0; i < rows.length; i++) {
    await breathe();
    for (let j = i + 1; j < rows.length; j++) {
      if (!inScope(rows[i], rows[j])) continue;
      const t = rows[i].normalized === rows[j].normalized ? 1 : trigramOverlap(grams[i], grams[j]);
      if (t >= CANDIDATE_TRIGRAM || isSubsetName(rows[i].normalized, rows[j].normalized)) {
        pairs.push({ a: rows[i], b: rows[j], trigram: t });
      }
    }
  }

  // Embeddings widen the net to names that don't look alike but read alike
  // ("the Free Officers" / "Free Officers Movement"). Only worth it above a
  // handful of entities, and only for rows we haven't embedded before.
  if (rows.length >= 8) {
    const missing = rows.filter((r) => !r.embedding);
    if (missing.length) {
      try {
        for (let i = 0; i < missing.length; i += 100) {
          const slice = missing.slice(i, i + 100);
          const { vectors } = await embed(
            slice.map((r) => `${r.canonical_name}${r.disambiguator ? ` — ${r.disambiguator}` : ""}`)
          );
          tx(() => {
            const stmt = db().prepare("UPDATE entities SET embedding=? WHERE id=?");
            slice.forEach((r, k) => {
              if (vectors[k]?.length) {
                const buf = toBlob(vectors[k]);
                stmt.run(buf, r.id);
                r.embedding = buf;
              }
            });
          });
        }
      } catch (err) {
        // Embeddings are an optimisation, not a requirement. A failure here
        // must not sink the pass — the trigram candidates still stand.
        console.warn("[corpus] embedding step skipped:", (err as Error).message);
      }
    }

    const vecs = new Map<number, Float32Array>();
    for (const r of rows) {
      const v = fromBlob(r.embedding);
      if (v) vecs.set(r.id, v);
    }
    const seen = new Set(pairs.map((p) => key(p.a.id, p.b.id)));
    for (let i = 0; i < rows.length; i++) {
      await breathe();
      const va = vecs.get(rows[i].id);
      if (!va) continue;
      for (let j = i + 1; j < rows.length; j++) {
        if (!inScope(rows[i], rows[j])) continue;
        const vb = vecs.get(rows[j].id);
        if (!vb || seen.has(key(rows[i].id, rows[j].id))) continue;
        if (cosine(va, vb) >= CANDIDATE_COSINE) {
          pairs.push({ a: rows[i], b: rows[j], trigram: trigramSimilarity(rows[i].normalized, rows[j].normalized) });
          seen.add(key(rows[i].id, rows[j].id));
        }
      }
    }

    // Without vectors the net above is spelling alone, and spelling cannot see
    // that إسرائيل is Israel or that IDF is the Israel Defense Forces: a
    // bilingual library with no embedding key was left with hundreds of such
    // twins. So when most names have no vector, the model reads the list of
    // names and points at likely twins. It only proposes — every pair is still
    // judged below on its evidence, under the same conservative instruction.
    if (vecs.size < rows.length / 2) {
      try {
        const found = await namePairs(rows, touched, seen);
        pairs.push(...found.pairs);
        tokensIn += found.tokensIn;
        tokensOut += found.tokensOut;
      } catch (err) {
        console.warn("[corpus] name-list step skipped:", (err as Error).message);
      }
    }
  }

  // --- decide ---------------------------------------------------------------
  const merged = new Map<number, number>(); // id -> id it was folded into
  const resolveId = (id: number): number => {
    let cur = id;
    while (merged.has(cur)) cur = merged.get(cur)!;
    return cur;
  };

  // A pair is found under the names it started with but merged as whatever
  // each side has since become. Merging the original row after it had already
  // been folded elsewhere moved an empty shell to a second survivor: the two
  // survivors stayed apart, and the second took an alias it never earned.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const mergePair = (p: { a: Row; b: Row }, reason: string) => {
    const a = byId.get(resolveId(p.a.id)) ?? p.a;
    const b = byId.get(resolveId(p.b.id)) ?? p.b;
    if (a.id === b.id) return;
    doMerge(a, b, reason, "auto", merged);
  };

  const needsJudgement: typeof pairs = [];

  for (const p of pairs) {
    await breathe();
    if (resolveId(p.a.id) === resolveId(p.b.id)) continue;

    // A lone given name is not evidence of identity, whoever says otherwise.
    //
    // This check sits ahead of the cached verdict deliberately. The bad merges
    // were re-applied on later runs as "Previously judged the same", so a
    // guard placed after the cache would have let every existing mistake back
    // in — including the ones this release exists to undo.
    if (type === "person" && !nameableTogether(p.a, p.b, rows)) {
      db()
        .prepare(
          "INSERT OR REPLACE INTO resolution_verdicts (type, a_norm, b_norm, same) VALUES (?, ?, ?, 0)"
        )
        .run(type, ...ordered(p.a.normalized, p.b.normalized));
      continue;
    }

    // A standing verdict wins over every heuristic below — including a user's
    // manual split, which is recorded as same=0 and must never be overridden.
    const cached = db()
      .prepare("SELECT same FROM resolution_verdicts WHERE type=? AND a_norm=? AND b_norm=?")
      .get(type, ...ordered(p.a.normalized, p.b.normalized)) as { same: number } | undefined;
    if (cached) {
      if (cached.same) mergePair(p, "Previously judged the same.");
      continue;
    }

    // Near-identical spelling: safe without asking.
    if (p.trigram >= AUTO_MERGE_TRIGRAM) {
      mergePair(p, `Names are near-identical (${p.trigram.toFixed(2)}).`);
      continue;
    }
    needsJudgement.push(p);
  }

  for (let i = 0; i < needsJudgement.length; i += BATCH) {
    const batch = needsJudgement.slice(i, i + BATCH).filter((p) => resolveId(p.a.id) !== resolveId(p.b.id));
    if (!batch.length) continue;

    const prompt = batch
      .map((p, n) => {
        return `PAIR ${n + 1}
A: "${p.a.canonical_name}"${p.a.disambiguator ? ` (${p.a.disambiguator})` : ""}
   evidence dated: ${dateSpan(p.a.id)}
   evidence: ${evidence(p.a.id)}
B: "${p.b.canonical_name}"${p.b.disambiguator ? ` (${p.b.disambiguator})` : ""}
   evidence dated: ${dateSpan(p.b.id)}
   evidence: ${evidence(p.b.id)}`;
      })
      .join("\n\n");

    const { data, usage } = await generateJson<{ verdicts: { pair: number; same: boolean; reason?: string }[] }>({
      stage: "resolve",
      system: SYSTEM,
      schema: SCHEMA,
      parts: [`Entity type: ${type}\n\n${prompt}`],
    });
    tokensIn += usage.tokensIn;
    tokensOut += usage.tokensOut;

    tx(() => {
      for (const v of data.verdicts ?? []) {
        const p = batch[v.pair - 1];
        if (!p) continue;
        db()
          .prepare(
            "INSERT OR REPLACE INTO resolution_verdicts (type, a_norm, b_norm, same) VALUES (?, ?, ?, ?)"
          )
          .run(type, ...ordered(p.a.normalized, p.b.normalized), v.same ? 1 : 0);
        if (v.same && resolveId(p.a.id) !== resolveId(p.b.id)) {
          mergePair(p, v.reason ?? "Model judged these the same.");
        }
      }
    });
  }

  finishTask(task.id, task.run_id, { tokensIn, tokensOut });
}

/**
 * Whether a lone word may stand for a fuller name.
 *
 * This is the guard that was missing, and its absence produced the worst class
 * of error this application can make: it invented a family. A bare entity
 * "Ahmed" folded into "Ahmed Razi" in one source; the same bare "Ahmed" was
 * elsewhere judged to be "Ahmed bin Abdulaziz", the brother of Mohammed bin
 * Salman. Once both had collapsed through that hub, a journalist and a Saudi
 * prince were one person, and every quote and relation of each belonged to the
 * other.
 *
 * The old rule matched the lone word against *any* token of a fuller name. That
 * is fine for a surname and catastrophic for a given name, because a given name
 * is the first token of hundreds of people. Three conditions now apply:
 *
 *   - it must match the LAST token. "Yamani" may stand for "Ahmed Zaki
 *     Yamani"; "Ahmed" may not. Sources shorten people to their family name,
 *     not to their first name.
 *   - no other entity anywhere may end in that same word, or the fold is a coin
 *     toss between them.
 *   - it must not be anyone's given name — if the word opens some other
 *     person's name, it is a given name, and a given name identifies nobody.
 *
 * Being wrong in the cautious direction leaves two entities that should be one,
 * which is visible and fixable. Being wrong the other way is neither.
 */
/**
 * The family name, as a match key.
 *
 * Reads the comma, which is the only thing that tells you where the family name
 * is. "Netanyahu, Benjamin" and "Benjamin Netanyahu" normalise to token lists in
 * opposite orders, so a rule based on token position alone gets exactly half of
 * them backwards — and it does so silently, folding "Naji" into "Tamimi, Naji"
 * (wrong, that is a given name) while refusing "Biden" for "Biden, Joe" (right,
 * and rejected anyway).
 */
function familyKey(rawName: string): string {
  return nameParts(rawName).family;
}

/**
 * A name's family and given parts, worked out once per name. canStandFor
 * scans every person for every pair it is asked about, and normalising the
 * same three thousand names afresh each time was most of a pass's minute.
 * The answer depends on the string alone, so the cache can never go stale.
 */
const partsCache = new Map<string, { family: string; given: string[] }>();

function nameParts(rawName: string): { family: string; given: string[] } {
  let parts = partsCache.get(rawName);
  if (parts) return parts;
  const words = normalize(rawName, "person").split(" ").filter(Boolean);
  const comma = rawName.indexOf(",");
  const family = comma > 0 ? normalize(rawName.slice(0, comma), "person") : words[words.length - 1] ?? "";
  parts = { family, given: words.filter((t) => t !== family) };
  if (partsCache.size >= 50_000) partsCache.clear();
  partsCache.set(rawName, parts);
  return parts;
}

/**
 * Whether two person names may be considered the same person at all.
 *
 * Applies only where one side is a single word, which is the whole problem: two
 * multi-word names can be compared on their merits, but "Ahmad" against "Ahmed
 * bin Abdulaziz" is not a judgement call, it is a category error. A given name
 * shared by half a country is not an identity claim, and asking a model to
 * adjudicate it invites a confident yes.
 */
export function nameableTogether(a: Row, b: Row, all: Row[]): boolean {
  const aBare = !a.normalized.includes(" ");
  const bBare = !b.normalized.includes(" ");
  if (aBare === bBare) return true; // both full, or both single — decide normally
  return aBare ? canStandFor(a, b, all) : canStandFor(b, a, all);
}

export function canStandFor(fragment: Row, full: Row, all: Row[]): boolean {
  const word = fragment.normalized;
  if (!word || word.includes(" ")) return false;
  if (familyKey(full.canonical_name) !== word) return false;

  let shareFamily = 0;
  for (const r of all) {
    if (r.id === fragment.id) continue;
    if (!r.normalized.includes(" ")) continue;
    if (givenNames(r.canonical_name).includes(word)) return false;
    if (familyKey(r.canonical_name) === word) shareFamily++;
  }
  return shareFamily === 1;
}

/** Every part of a name that is not the family name. */
function givenNames(rawName: string): string[] {
  return nameParts(rawName).given;
}

/**
 * Folds a lone "Nasser" into "Gamal Abdel Nasser" — but only where the source
 * itself makes it unambiguous.
 *
 * Extraction records the name as the passage wrote it, so a chapter that says
 * "Nasser" once after introducing him properly produces a second, one-mention
 * entity. The library had 120 of these: Aaron, Abdul, Badr, Beethoven.
 *
 * The rule is deliberately narrow. A bare name is folded only when exactly one
 * fuller name in the *same source* can stand for it — see `canStandFor`, which
 * is where the real safety lives. Two candidates means the book really does
 * have two Abduls, and guessing between them would put words in the wrong
 * person's mouth, so it is left alone for the model or for you to settle.
 */
export function foldBareNames(rows: Row[], handle?: Database.Database) {
  // The migration calls this from inside the database's own open(), before the
  // global handle is set — so it passes its own. Calling db() there would
  // re-enter open() and recurse until the stack gives out.
  const conn = handle ?? db();
  const bare = rows.filter(
    (r) => !r.normalized.includes(" ") && r.normalized.length > 2 && r.mentions <= 2
  );
  if (!bare.length) return;

  const sourcesOf = conn.prepare("SELECT DISTINCT source_id FROM mentions WHERE entity_id = ?");

  // Fuller names by family name: canStandFor refuses any other, so each bare
  // name need only look at the few that end in it, not the whole list.
  const byFamily = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.normalized.includes(" ")) continue;
    const family = familyKey(r.canonical_name);
    const list = byFamily.get(family);
    if (list) list.push(r);
    else byFamily.set(family, [r]);
  }

  for (const fragment of bare) {
    const sources = (sourcesOf.all(fragment.id) as { source_id: number }[]).map((s) => s.source_id);
    if (!sources.length) continue;

    // Fuller names that share this word and appear in at least one of the same
    // sources. A name met only in a different book is not the same person by
    // default.
    const candidates = (byFamily.get(fragment.normalized) ?? []).filter(
      (other) => other.id !== fragment.id && canStandFor(fragment, other, rows)
    );

    const inSameSource = candidates.filter((c) => {
      const theirs = (sourcesOf.all(c.id) as { source_id: number }[]).map((s) => s.source_id);
      return theirs.some((s) => sources.includes(s));
    });

    if (inSameSource.length !== 1) continue;

    const full = inSameSource[0];
    mergeEntities(
      full.id,
      fragment.id,
      `"${fragment.canonical_name}" is the only ${full.canonical_name} in this source.`,
      "auto",
      conn
    );
    // Keep the in-memory view honest for the pair pass that follows.
    fragment.mentions = 0;
    full.mentions += 1;
  }
}

/** Above this many names one list no longer fits comfortably in a call. */
const NAME_LIST_MAX = 2500;
/** A "group" bigger than this is a theme, not one entity under several names. */
const NAME_GROUP_MAX = 6;

const NAME_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    groups: {
      type: Type.ARRAY,
      items: { type: Type.ARRAY, items: { type: Type.INTEGER } },
      description: "Each group: the numbers of names that may be one entity.",
    },
  },
  required: ["groups"],
};

const NAME_SYSTEM = `You look over the names in a research library and point out names
that may be the same real thing written differently: a translation or
transliteration between Arabic and English, an acronym and its full name, a
short and a long form, a misspelling. You only propose; every group is checked
afterwards against the passages the names appear in.

Group only names that could be one and the same entity. Things that are merely
related are not the same: a company and its parent or subsidiary, a city and its
country, a ministry and the army under it, a person and the firm named after
them. Leave out every name with no likely twin. Answer with the numbers shown
before each name.`;

/**
 * Candidate pairs from the model reading the list of names, for a library
 * whose names have no vectors. With `touched`, only twins of the names that
 * source brought in are asked for.
 */
async function namePairs(
  rows: Row[],
  touched: Set<number> | null,
  seen: Set<string>
): Promise<{ pairs: { a: Row; b: Row; trigram: number }[]; tokensIn: number; tokensOut: number }> {
  const none = { pairs: [], tokensIn: 0, tokensOut: 0 };
  if (touched && touched.size === 0) return none;
  if (rows.length > NAME_LIST_MAX) {
    console.warn(`[corpus] name-list step skipped: ${rows.length} names is more than one list can carry`);
    return none;
  }

  const list = rows
    .map((r, n) => `${n + 1}. ${r.canonical_name}${r.disambiguator ? ` (${r.disambiguator})` : ""}`)
    .join("\n");
  const ask = touched
    ? `Only groups that include at least one of these numbers, the names just added: ${rows
        .map((r, n) => (touched.has(r.id) ? n + 1 : 0))
        .filter(Boolean)
        .join(", ")}.`
    : "Every group you can find.";

  const { data, usage } = await generateJson<{ groups: number[][] }>({
    stage: "resolve",
    system: NAME_SYSTEM,
    schema: NAME_SCHEMA,
    parts: [`${ask}\n\nNames:\n${list}`],
    timeoutMs: 5 * 60_000,
  });

  const pairs: { a: Row; b: Row; trigram: number }[] = [];
  for (const group of data.groups ?? []) {
    const members = [...new Set(group)].map((n) => rows[n - 1]).filter(Boolean);
    if (members.length < 2 || members.length > NAME_GROUP_MAX) continue;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const [a, b] = [members[i], members[j]];
        if (touched && !touched.has(a.id) && !touched.has(b.id)) continue;
        if (seen.has(key(a.id, b.id))) continue;
        seen.add(key(a.id, b.id));
        pairs.push({ a, b, trigram: trigramSimilarity(a.normalized, b.normalized) });
      }
    }
  }
  return { pairs, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut };
}

function key(a: number, b: number) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Lets the server answer between stretches of comparing.
 *
 * The worker runs in the server's own process, and a pass compares thousands
 * of names in plain loops. Without a pause the whole server stood still for
 * the length of the pass — a minute and more on a large library — and every
 * open window put up "The Corpus server is down". Awaiting the returned
 * function costs nothing until ~25 ms have gone by, then yields once.
 */
function breather(sliceMs = 25): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < sliceMs) return;
    await new Promise<void>((r) => setImmediate(r));
    since = performance.now();
  };
}

function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** The entities holding live evidence from one source, as a set of ids. */
function touchedBy(sourceId: number, rows: Row[]): Set<number> {
  const ids = new Set(
    (
      db()
        .prepare("SELECT DISTINCT entity_id FROM live_mentions WHERE source_id=?")
        .all(sourceId) as { entity_id: number }[]
    ).map((r) => r.entity_id)
  );
  // Rows that no longer exist as live entities cannot anchor a pair.
  const live = new Set(rows.map((r) => r.id));
  for (const id of ids) if (!live.has(id)) ids.delete(id);
  return ids;
}

/**
 * The three richest live quotes: those carrying both a claim and a context
 * first, then the longest. The adjudicator used to get the three oldest rows
 * from the raw table, which are usually the thinnest — a name in passing —
 * and could include passages you had already discarded.
 */
export function evidence(entityId: number): string {
  const rows = db()
    .prepare(
      `SELECT quote, context FROM live_mentions
        WHERE entity_id=?
        ORDER BY (claim IS NOT NULL) + (context IS NOT NULL) DESC, length(quote) DESC, id
        LIMIT 3`
    )
    .all(entityId) as { quote: string; context: string | null }[];
  if (!rows.length) return "(none)";
  return rows
    .map((r) => `"${r.quote.slice(0, 220)}"${r.context ? ` [about: ${r.context.slice(0, 80)}]` : ""}`)
    .join(" / ");
}

/**
 * When an entity's evidence was published, earliest to latest. On a political
 * beat this separates most namesakes for free: the evidence for two Trudeaus
 * sits decades apart.
 */
export function dateSpan(entityId: number): string {
  const row = db()
    .prepare(
      `SELECT MIN(substr(COALESCE(s.published_at, s.year), 1, 10)) AS lo,
              MAX(substr(COALESCE(s.published_at, s.year), 1, 10)) AS hi
         FROM live_mentions m JOIN sources s ON s.id = m.source_id
        WHERE m.entity_id=? AND COALESCE(s.published_at, s.year) IS NOT NULL`
    )
    .get(entityId) as { lo: string | null; hi: string | null } | undefined;
  if (!row?.lo) return "undated";
  return row.lo === row.hi ? row.lo : `${row.lo} to ${row.hi}`;
}

/** Keeps whichever entity has more evidence behind it. */
export function doMerge(
  a: { id: number; canonical_name: string; mentions: number },
  b: { id: number; canonical_name: string; mentions: number },
  reason: string,
  actor: "auto" | "user",
  ledger?: Map<number, number>
) {
  const [keep, drop] = a.mentions >= b.mentions ? [a, b] : [b, a];
  mergeEntities(keep.id, drop.id, reason, actor);
  ledger?.set(drop.id, keep.id);
  // The survivor now carries both, which the next "more evidence" choice in
  // the same pass has to see.
  keep.mentions += drop.mentions;
  drop.mentions = 0;
}

export function mergeEntities(
  keepId: number,
  dropId: number,
  reason: string,
  actor: "auto" | "user",
  handle?: Database.Database
) {
  if (keepId === dropId) return;
  const conn = handle ?? db();
  const run = () => {
    // Only ever between survivors. An entity already folded elsewhere has
    // given up its evidence; merging it again moves nothing but its name.
    const parent = conn.prepare("SELECT merged_into FROM entities WHERE id=?");
    const rootOf = (id: number) => {
      let cur = id;
      for (let hops = 0; hops < 64; hops++) {
        const r = parent.get(cur) as { merged_into: number | null } | undefined;
        if (!r || r.merged_into === null) break;
        cur = r.merged_into;
      }
      return cur;
    };
    keepId = rootOf(keepId);
    dropId = rootOf(dropId);
    if (keepId === dropId) return;

    const keep = conn.prepare("SELECT canonical_name FROM entities WHERE id=?").get(keepId) as { canonical_name: string } | undefined;
    const drop = conn.prepare("SELECT canonical_name FROM entities WHERE id=?").get(dropId) as { canonical_name: string } | undefined;
    if (!keep || !drop) return;

    conn.prepare("UPDATE mentions SET entity_id=? WHERE entity_id=?").run(keepId, dropId);
    conn.prepare("UPDATE events   SET entity_id=? WHERE entity_id=?").run(keepId, dropId);
    conn.prepare("UPDATE relations SET from_entity=? WHERE from_entity=?").run(keepId, dropId);
    conn.prepare("UPDATE relations SET to_entity=?   WHERE to_entity=?").run(keepId, dropId);
    conn
      .prepare("UPDATE OR IGNORE aliases SET entity_id=? WHERE entity_id=?")
      .run(keepId, dropId);
    conn.prepare("DELETE FROM aliases WHERE entity_id=?").run(dropId);
    // The absorbed name becomes a way to find the survivor.
    conn
      .prepare("INSERT OR IGNORE INTO aliases (entity_id, surface, normalized) SELECT ?, canonical_name, normalized FROM entities WHERE id=?")
      .run(keepId, dropId);

    conn
      .prepare("UPDATE entities SET merged_into=?, entry_state='none' WHERE id=?")
      .run(keepId, dropId);
    // The survivor's entry no longer reflects its evidence.
    conn.prepare("UPDATE entities SET entry_state='stale' WHERE id=? AND entry_state='fresh'").run(keepId);
    conn.prepare("DELETE FROM entries WHERE entity_id=?").run(dropId);

    conn
      .prepare(
        `INSERT INTO merge_log (kept_entity, merged_entity, kept_name, merged_name, reason, actor)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(keepId, dropId, keep.canonical_name, drop.canonical_name, reason, actor);
  };
  // Callers are sometimes already inside a transaction.
  if (conn.inTransaction) run();
  else if (handle) conn.transaction(run)();
  else tx(run);
}

/** Reverses a merge: the absorbed entity comes back with its own evidence.
 *  Only mentions are reassigned — relations and events follow their mentions. */
export function undoMerge(mergeId: number): boolean {
  return undoMergeWith(mergeId);
}

/**
 * As `undoMerge`, but able to run on a handle the caller supplies.
 *
 * Migrations run inside the database's own `open()`, before the global handle
 * exists, so anything they call must take the connection as a parameter —
 * calling `db()` there re-enters `open()` and recurses until the stack gives
 * out. Same rule as `foldBareNames` and `mergeEntities`.
 */
export function undoMergeWith(mergeId: number, handle?: Database.Database): boolean {
  const conn = handle ?? db();
  const run = (): boolean => {
    const log = conn
      .prepare("SELECT * FROM merge_log WHERE id=? AND undone=0")
      .get(mergeId) as
      | { id: number; kept_entity: number; merged_entity: number; merged_name: string }
      | undefined;
    if (!log) return false;

    const dropped = conn
      .prepare("SELECT id, normalized FROM entities WHERE id=?")
      .get(log.merged_entity) as { id: number; normalized: string } | undefined;
    if (!dropped) return false;

    conn.prepare("UPDATE entities SET merged_into=NULL WHERE id=?").run(log.merged_entity);
    conn
      .prepare("DELETE FROM aliases WHERE entity_id=? AND normalized=?")
      .run(log.kept_entity, dropped.normalized);
    conn
      .prepare("INSERT OR IGNORE INTO aliases (entity_id, surface, normalized) VALUES (?, ?, ?)")
      .run(log.merged_entity, log.merged_name, dropped.normalized);

    // Send back the mentions whose surface form matches the split-off name.
    conn
      .prepare(
        `UPDATE mentions SET entity_id=?
          WHERE entity_id=? AND lower(surface)=lower(?)`
      )
      .run(log.merged_entity, log.kept_entity, log.merged_name);

    conn
      .prepare("UPDATE entities SET entry_state='stale' WHERE id IN (?, ?) AND entry_state='fresh'")
      .run(log.kept_entity, log.merged_entity);
    conn.prepare("UPDATE merge_log SET undone=1 WHERE id=?").run(mergeId);

    // Record the split as a standing verdict, or the next resolve pass would
    // cheerfully merge them straight back together.
    const kept = conn
      .prepare("SELECT normalized, type FROM entities WHERE id=?")
      .get(log.kept_entity) as { normalized: string; type: string } | undefined;
    if (kept) {
      conn
        .prepare(
          "INSERT OR REPLACE INTO resolution_verdicts (type, a_norm, b_norm, same) VALUES (?, ?, ?, 0)"
        )
        .run(kept.type, ...ordered(kept.normalized, dropped.normalized));
    }
    return true;
  };

  if (conn.inTransaction) return run();
  if (handle) return conn.transaction(run)();
  return tx(run);
}
