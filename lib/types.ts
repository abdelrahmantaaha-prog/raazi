export type SourceKind = "pdf" | "epub" | "text" | "url" | "media";

export type EntityType =
  | "person"
  | "org"
  | "institution"
  | "event"
  | "place"
  | "work"
  | "concept";

export const ENTITY_TYPES: EntityType[] = [
  "person",
  "org",
  "institution",
  "event",
  "place",
  "work",
  "concept",
];

export const ENTITY_LABEL: Record<EntityType, string> = {
  person: "People",
  // Covers companies, but also movements, armies, and parties — which is why
  // it is not labelled "Companies".
  org: "Organizations",
  institution: "Institutions",
  event: "Events",
  place: "Places",
  work: "Works",
  concept: "Concepts",
};

export type RunState =
  | "queued"
  | "running"
  | "paused_quota"
  | "paused_user"
  | "paused_budget"
  | "paused_key"
  | "done"
  | "failed";

export const PAUSED_STATES: RunState[] = [
  "paused_quota",
  "paused_user",
  "paused_budget",
  "paused_key",
];

export type TaskState =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "superseded";

export type TaskKind =
  | "extract"
  | "ocr"
  | "resolve"
  | "entry"
  | "transcribe"
  /** A second look at an already-read passage, for what the first pass missed.
   *  Strictly additive. See lib/pipeline/enhance.ts. */
  | "enhance"
  /** Finds further appearances of entities already known, by exact name match.
   *  Costs no tokens. See lib/pipeline/sweep.ts. */
  | "sweep"
  /** Checks that an entry's evidence is all about one person, and separates it
   *  when it is not. See lib/pipeline/identity.ts. */
  | "identity"
  /** Recovers what a quote refers back to, for quotes that cannot stand alone.
   *  See lib/pipeline/context.ts. */
  | "context"
  /** Free bookkeeping step: finds the passages whose quotes cannot stand alone
   *  and queues a resolution call for each. Runs after the sweep. */
  | "plan_context"
  /** Reads a finished entry whole and fixes how it hangs together, without
   *  adding a single fact. See lib/pipeline/coherence.ts. */
  | "coherence"
  /** Reads a finished entry back against the passages it cites, and records
   *  the sentences they do not bear out. See lib/pipeline/verify.ts. */
  | "verify"
  /** Files a source under the research topics it belongs to. Runs first. */
  | "tag"
  /** Answers a question put to the whole library. */
  | "ask"
  /** Checks a draft against the library. Reports; never edits. */
  | "factcheck"
  /** Builds study cards from evidence. */
  | "cards"
  /** Finds a picture for one entity. Costs no tokens; costs patience. */
  | "portrait"
  /** Decides which entries deserve a picture and queues them. */
  | "plan_portraits"
  /** Free bookkeeping step: decides which entities have earned an entry and
   *  queues them. Runs after resolution, when the entity set has settled. */
  | "plan_entries";

export interface Locator {
  page?: number;
  chapter?: string;
  timecode?: string;
  charStart?: number;
  charEnd?: number;
}

export interface Source {
  id: number;
  title: string;
  author: string | null;
  kind: SourceKind;
  path: string | null;
  url: string | null;
  year: string | null;
  publisher: string | null;
  lang: string | null;
  status: string;
  note: string | null;
  meta_json: string;
  added_at: string;
}

export interface Chunk {
  id: number;
  source_id: number;
  doc_id: number | null;
  seq: number;
  text: string;
  token_est: number;
  locator_json: string;
  extracted_at: string | null;
  skip_reason: string | null;
}

export interface Entity {
  id: number;
  type: EntityType;
  canonical_name: string;
  normalized: string;
  disambiguator: string | null;
  lang: string | null;
  starred: number;
  entry_state: "none" | "stale" | "fresh";
  created_at: string;
  merged_into: number | null;
}

export interface Mention {
  id: number;
  entity_id: number;
  chunk_id: number;
  source_id: number;
  surface: string;
  quote: string;
  claim: string | null;
  /** What the quote refers back to, when it leans on earlier material. */
  context: string | null;
  starred: number;
  confidence: number;
}

export interface Run {
  id: number;
  source_id: number | null;
  kind: string;
  label: string | null;
  state: RunState;
  resume_at: string | null;
  tokens_in: number;
  tokens_out: number;
  budget_cap: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: number;
  run_id: number;
  seq: number;
  kind: TaskKind;
  payload_json: string;
  state: TaskState;
  attempts: number;
  last_error: string | null;
  tokens_in: number;
  tokens_out: number;
  updated_at: string;
}

/** What the extraction call returns for a single chunk. */
export interface ExtractedEntity {
  surface: string;
  type: EntityType;
  disambiguator?: string;
  claim?: string;
  quote: string;
  /** What a back-reference in the quote points at, resolved from earlier text. */
  context?: string;
  /** The passage discussed this entity without naming it; the name came from
   *  the preceding text. Recorded at lower confidence. */
  fromContext?: boolean;
}

/**
 * The confidence extraction records when it recovered the name from context
 * rather than reading it in the passage.
 *
 * A named constant because two stages have to agree on it and for a long time
 * they did not. Extraction writes 0.6 here; the name-matching sweep writes 0.8
 * for something entirely different — evidence found by matching the name, which
 * is therefore *certainly* named. The entry writer tested `confidence < 1` and
 * so told itself "this passage does not name the subject" about 351 passages
 * that named it outright, against a single one that did not.
 */
export const FROM_CONTEXT_CONFIDENCE = 0.6;

/** Whether a mention's name was recovered from its surroundings. */
export function isFromContext(confidence: number): boolean {
  return confidence <= FROM_CONTEXT_CONFIDENCE;
}

/** One row per distinct passage, keeping the best-annotated copy of each.
 *
 * The same sentence reaches an entity more than once — extraction and the sweep
 * both find it, or a resumed run re-reads a chunk. Left alone, the writer sees
 * one passage three times and cites all three, and the entry then carries three
 * citation markers where a reader is entitled to read three passages agreeing.
 * That is a fabricated weight of evidence, which is the one thing this tool
 * exists not to do. */
export function dedupeByQuote<
  T extends { id: number; quote: string; claim: string | null; context: string | null }
>(rows: T[]): T[] {
  const best = new Map<string, T>();
  const richness = (r: T) => (r.claim ? 1 : 0) + (r.context ? 1 : 0);
  for (const r of rows) {
    const key = r.quote.replace(/\s+/g, " ").trim().toLowerCase();
    const seen = best.get(key);
    // Keep whichever copy carries more of the annotation the writer needs; ties
    // go to the earlier row, so the choice is stable across runs.
    if (!seen || richness(r) > richness(seen)) best.set(key, r);
  }
  return [...best.values()].sort((a, b) => a.id - b.id);
}

export interface ExtractedRelation {
  from: string;
  to: string;
  type: string;
  quote?: string;
  context?: string;
}

export interface ExtractedEvent {
  entity: string;
  dateText?: string;
  dateIso?: string;
  precision?: string;
  summary: string;
  context?: string;
}

export interface ChunkExtraction {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  events: ExtractedEvent[];
}
