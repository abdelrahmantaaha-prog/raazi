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
  /** Reads a shipping paper whole for the shipment it records: parties, places,
   *  goods, papers, and links to other shipping papers. See lib/pipeline/shipment.ts. */
  | "shipment"
  /** Looks a shipment up on the open web and in public records, asked for by
   *  hand. See lib/pipeline/shipcheck.ts. */
  | "shipcheck"
  /** Checks a draft or a source on the open web, asked for by hand. See
   *  handleTextWebcheck in lib/pipeline/webcheck.ts. */
  | "webcheck_text"
  /** Finds research and news on a draft, a source or a highlighted passage,
   *  asked for by hand. See lib/pipeline/litreview.ts. */
  | "litreview"
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
  /** Checks a draft against the library. Reports; never edits. */
  | "factcheck"
  /** Checks an entry, or its connections, against the open web, on request.
   *  Reports; never edits. See lib/pipeline/webcheck.ts. */
  | "webcheck"
  /** Reads one file of a folder you brought in whole. See lib/folders.ts. */
  | "folder_file"
  /** Finds a picture for one entity. Costs no tokens; costs patience. */
  | "portrait"
  /** Decides which entries deserve a picture and queues them. */
  | "plan_portraits"
  /** Free bookkeeping step: decides which entities have earned an entry and
   *  queues them. Runs after resolution, when the entity set has settled. */
  | "plan_entries"
  /** Free: which feeds are due a look. See lib/pipeline/poll.ts. */
  | "plan_polls"
  /** Fetches one feed and records what it carries. Costs no tokens. */
  | "poll"
  /** Turns one feed item into a source, which starts the ordinary ingest. */
  | "fetch_item"
  /** Writes the daily brief from what arrived. See lib/pipeline/brief.ts. */
  | "brief"
  /** A closer look at one heading of a written brief. See lib/pipeline/expand.ts. */
  | "expand";

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
  /** When it was published, as ISO; a book has only its year. */
  published_at?: string | null;
  outlet?: string | null;
  section?: string | null;
  dateline?: string | null;
  /** The address with tracking stripped; what duplicate stories are matched on. */
  canonical_url?: string | null;
  /** Your own note on how far to trust this source. */
  reliability?: string | null;
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
  /** Who is asserting the claim, and what kind of claim it is. Null on rows
   *  written before extraction recorded them. */
  attribution?: string | null;
  claim_kind?: string | null;
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
  /** Do not run before this time (ISO); a retry waits here instead of
   *  sleeping inside the worker and holding up the queue. */
  not_before?: string | null;
  /** Ordering within a priority; lower runs first. */
  order_hint?: number | null;
  /** The model this task is pinned to, when it is. */
  model?: string | null;
}

/**
 * What sort of assertion a passage makes. "Officials said the tariff would
 * take effect Monday" is a report of someone else's claim, not the source's
 * own; a newsroom lives on that difference, so extraction records it.
 */
export type ClaimKind = "fact" | "allegation" | "opinion" | "forecast" | "denial" | "quotation";

export const CLAIM_KINDS: ClaimKind[] = ["fact", "allegation", "opinion", "forecast", "denial", "quotation"];

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
  /** Who asserts the claim: "source" for the text's own voice, otherwise the
   *  person, body or document the text credits, as the text puts it. */
  attribution?: string;
  claimKind?: ClaimKind;
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
