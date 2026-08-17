import type Database from "better-sqlite3";
import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { embed, generateJson } from "../ai/client";
import { cosine, fromBlob, isSubsetName, normalize, toBlob, trigramSimilarity } from "../normalize";
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
the record in a way that is hard to notice later. When the evidence does not
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
  const { type } = JSON.parse(task.payload_json) as { type: EntityType };

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
  const pairs: { a: Row; b: Row; trigram: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const t = trigramSimilarity(rows[i].normalized, rows[j].normalized);
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
      const va = vecs.get(rows[i].id);
      if (!va) continue;
      for (let j = i + 1; j < rows.length; j++) {
        const vb = vecs.get(rows[j].id);
        if (!vb || seen.has(key(rows[i].id, rows[j].id))) continue;
        if (cosine(va, vb) >= CANDIDATE_COSINE) {
          pairs.push({ a: rows[i], b: rows[j], trigram: trigramSimilarity(rows[i].normalized, rows[j].normalized) });
        }
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

  const needsJudgement: typeof pairs = [];

  for (const p of pairs) {
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
      if (cached.same) doMerge(p.a, p.b, "Previously judged the same.", "auto", merged);
      continue;
    }

    // Near-identical spelling: safe without asking.
    if (p.trigram >= AUTO_MERGE_TRIGRAM) {
      doMerge(p.a, p.b, `Names are near-identical (${p.trigram.toFixed(2)}).`, "auto", merged);
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
   evidence: ${evidence(p.a.id)}
B: "${p.b.canonical_name}"${p.b.disambiguator ? ` (${p.b.disambiguator})` : ""}
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
          doMerge(p.a, p.b, v.reason ?? "Model judged these the same.", "auto", merged);
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
  const comma = rawName.indexOf(",");
  if (comma > 0) return normalize(rawName.slice(0, comma), "person");
  const parts = normalize(rawName, "person").split(" ").filter(Boolean);
  return parts[parts.length - 1] ?? "";
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
  const family = familyKey(rawName);
  return normalize(rawName, "person")
    .split(" ")
    .filter((t: string) => t && t !== family);
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

  for (const fragment of bare) {
    const sources = (sourcesOf.all(fragment.id) as { source_id: number }[]).map((s) => s.source_id);
    if (!sources.length) continue;

    // Fuller names that share this word and appear in at least one of the same
    // sources. A name met only in a different book is not the same person by
    // default.
    const candidates = rows.filter(
      (other) =>
        other.id !== fragment.id &&
        other.normalized.includes(" ") &&
        canStandFor(fragment, other, rows)
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

function key(a: number, b: number) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function evidence(entityId: number): string {
  const rows = db()
    .prepare("SELECT quote FROM mentions WHERE entity_id=? ORDER BY id LIMIT 3")
    .all(entityId) as { quote: string }[];
  if (!rows.length) return "(none)";
  return rows.map((r) => `"${r.quote.slice(0, 220)}"`).join(" / ");
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
