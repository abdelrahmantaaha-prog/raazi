import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, db } from "./db";
import { stripLeadingTitles } from "./normalize";
import { zoomForClasses } from "./geo";
import type { EntityType } from "./types";

/**
 * A picture for an entry, from Wikidata and Wikimedia Commons.
 *
 * No key, no account, no tokens. The lookup is name → Wikidata record → the
 * record's own image, and the file is kept on disk afterwards so a page render
 * never touches the network.
 *
 * The whole design is strict on purpose, exactly as the book covers are: a
 * confidently wrong photograph on a research entry is much worse than a blank
 * one, and a photograph is more convincing than a book cover, so the bar is
 * higher. Two independent things must agree before anything is stored — the
 * name, and what Wikidata says the thing *is*. Everything else is left for you
 * to settle by hand.
 */

export const PORTRAITS_DIR = path.join(DATA_DIR, "portraits");
const UA = "Raazi/0.1 (personal research tool; single-user, local)";
const API = "https://www.wikidata.org/w/api.php";

/**
 * Wikidata answers 429 readily, and the threshold is not published. So the gap
 * between calls is not a constant but a thermostat: it widens when we are
 * refused and creeps back down while we are not. A fixed 1.2s was measured
 * getting through four lookups and being refused on the fifth.
 */
const MIN_GAP_MS = 1500;
const MAX_GAP_MS = 15_000;
let gap = MIN_GAP_MS;
let lastCall = 0;

export interface PortraitState {
  /** "hit" with a file on disk, "miss" if we looked and found nothing. */
  portrait?: "hit" | "miss";
  portraitAt?: string;
  /** Q-number, so the choice can be audited or corrected. */
  wikidata?: string;
  /** The Commons filename, which is also its attribution handle. */
  commons?: string;
  /** Set when you picked it rather than the automatic match. */
  portraitBy?: "you";
  /**
   * Where the thing is, from the same record. Free: P625 arrives in the claims
   * we already download for the picture, so a located place costs no extra
   * request. Kept even when there is no picture — a place with no photograph
   * still has a position.
   */
  lat?: number;
  lon?: number;
  /** How closely to frame it, from what Wikidata says it is. */
  zoom?: number;
}

export function portraitPath(entityId: number): string {
  return path.join(PORTRAITS_DIR, `${entityId}.jpg`);
}

export function cachedPortrait(entityId: number): string | null {
  const p = portraitPath(entityId);
  return fs.existsSync(p) ? p : null;
}

/**
 * Every entity that has a picture, in one directory read.
 *
 * The pedia lists hundreds of entities at a time and most have no picture. Left
 * to the browser that is hundreds of requests answered 404, so the list asks
 * the disk once instead and only renders an image where there is one.
 */
export function havePortraits(): Set<number> {
  try {
    return new Set(
      fs
        .readdirSync(PORTRAITS_DIR)
        .map((f) => Number(f.replace(/\.jpg$/i, "")))
        .filter((n) => Number.isFinite(n))
    );
  } catch {
    // Nothing has been looked up yet, so the directory does not exist.
    return new Set();
  }
}

export function portraitState(entityId: number): PortraitState {
  const row = db().prepare("SELECT meta_json FROM entities WHERE id=?").get(entityId) as
    | { meta_json: string | null }
    | undefined;
  try {
    return JSON.parse(row?.meta_json ?? "{}") as PortraitState;
  } catch {
    return {};
  }
}

export function setPortraitState(entityId: number, patch: PortraitState): void {
  const next = { ...portraitState(entityId), ...patch };
  db().prepare("UPDATE entities SET meta_json=? WHERE id=?").run(JSON.stringify(next), entityId);
}

export function knownMiss(entityId: number): boolean {
  return portraitState(entityId).portrait === "miss";
}

// ---------------------------------------------------------------------------
// Wikidata
// ---------------------------------------------------------------------------

/**
 * What Wikidata's "instance of" (P31) has to say for each of our types.
 *
 * A record whose class is in the list is accepted; anything else is refused,
 * which is what stops a person's name resolving to a film about them or a ship
 * named after them. The lists are shallow — no traversal of the class
 * hierarchy, which would need a second request per candidate — so they are
 * generous within a type and strict between types.
 */
const CLASSES: Record<EntityType | string, string[]> = {
  person: ["Q5"],
  org: [
    "Q4830453", "Q6881511", "Q783794", "Q43229", "Q891723", "Q1616075",
    "Q4438121", "Q163740", "Q7278", "Q48204", "Q17127659", "Q1934969",
  ],
  institution: [
    "Q43229", "Q163740", "Q3918", "Q875538", "Q2385804", "Q31855", "Q327333",
    "Q7188", "Q1785271", "Q15911314", "Q48204",
  ],
  place: [
    "Q6256", "Q3624078", "Q515", "Q486972", "Q56061", "Q82794", "Q15284",
    "Q1549591", "Q35657", "Q10864048", "Q7275", "Q51576574", "Q107390",
  ],
  event: [
    "Q1656682", "Q198", "Q178561", "Q180684", "Q1190554", "Q13418847",
    "Q625298", "Q45382", "Q124734", "Q3199915", "Q40231", "Q2334719",
  ],
  work: ["Q571", "Q7725634", "Q11424", "Q47461344", "Q234460", "Q49848", "Q838948"],
  concept: [],
};

interface Candidate {
  id: string;
  label: string;
  description: string | null;
  classes: string[];
  /** Commons filename, when the record has a picture at all. */
  file: string | null;
  /** True when the record's class matches the entity's type. */
  typeMatches: boolean;
  thumb: string | null;
  /** P625, when the record has coordinates. */
  lat: number | null;
  lon: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function polite<T>(fn: () => Promise<T>): Promise<T> {
  const wait = Math.max(0, lastCall + gap - Date.now());
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return fn();
}

/** A refusal the caller should come back for, not one it should give up on. */
export class RateLimited extends Error {
  readonly status = 429;
  constructor() {
    super("Wikidata is rate-limiting; the rest will be picked up shortly.");
    this.name = "RateLimited";
  }
}

async function api(params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = `${API}?${new URLSearchParams({ format: "json", origin: "*", ...params })}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await polite(() => fetch(url, { headers: { "user-agent": UA } }));

    if (res.status === 429) {
      // Widen the standing gap, not just this wait: being refused once means
      // the next call is likely to be refused too.
      gap = Math.min(Math.round(gap * 1.6), MAX_GAP_MS);
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Wikidata returned ${res.status}`);

    // Behaving: ease back towards the floor so a single bad patch does not
    // slow every lookup for the rest of the run.
    gap = Math.max(MIN_GAP_MS, Math.round(gap * 0.9));
    return (await res.json()) as Record<string, unknown>;
  }
  throw new RateLimited();
}

/** A Commons file, at a width worth storing but not worth waiting for. */
export function commonsThumb(file: string, width = 500): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`;
}

/**
 * Names as they should be asked about.
 *
 * The stored heading may carry a rank the outside world does not use — Wikidata
 * finds nothing whatever for "Prime Minister Netanyahu" and the right person
 * instantly for "Netanyahu" — so the bare name is tried first, and the stored
 * form only as a fallback in case the title was part of the name after all.
 */
export function searchTerms(name: string, type: string): string[] {
  const terms: string[] = [];
  if (type === "person") {
    const bare = stripLeadingTitles(name.trim().split(/\s+/), 1).join(" ");
    if (bare && bare !== name) terms.push(bare);
  }
  terms.push(name.trim());
  // "Kohelet Policy Forum (KPF)" — the parenthetical is ours, not the world's.
  const withoutParens = name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  if (withoutParens && !terms.includes(withoutParens)) terms.push(withoutParens);
  return terms.filter(Boolean);
}

/** Looks up candidates for a name, newest-first by Wikidata's own ranking. */
export async function candidates(name: string, type: string, limit = 6): Promise<Candidate[]> {
  const seen = new Set<string>();
  const hits: { id: string; label: string; description: string | null }[] = [];

  for (const term of searchTerms(name, type)) {
    if (hits.length >= limit) break;
    const search = (await api({
      action: "wbsearchentities",
      language: "en",
      uselang: "en",
      limit: String(limit),
      search: term,
    })) as { search?: { id: string; label?: string; description?: string }[] };

    for (const s of search.search ?? []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      hits.push({ id: s.id, label: s.label ?? s.id, description: s.description ?? null });
    }
  }
  if (hits.length === 0) return [];

  const entities = (await api({
    action: "wbgetentities",
    props: "claims",
    ids: hits.slice(0, 12).map((h) => h.id).join("|"),
  })) as { entities?: Record<string, { claims?: Record<string, ClaimRow[]> }> };

  const wanted = CLASSES[type] ?? [];

  return hits.slice(0, 12).map((h) => {
    const claims = entities.entities?.[h.id]?.claims ?? {};
    const classes = (claims.P31 ?? [])
      .map((c) => c.mainsnak?.datavalue?.value)
      .map((v) => (typeof v === "object" && v && "id" in v ? (v as { id: string }).id : null))
      .filter((v): v is string => Boolean(v));

    // P18 is the image; organisations rarely have one and carry a logo (P154)
    // instead, which is the right picture for them anyway.
    const image = claims.P18?.[0]?.mainsnak?.datavalue?.value;
    const logo = claims.P154?.[0]?.mainsnak?.datavalue?.value;
    const file = typeof image === "string" ? image : typeof logo === "string" ? logo : null;

    // P625 rides along in the claims we already have. Reading it here is what
    // makes a map cost nothing.
    const coords = claims.P625?.[0]?.mainsnak?.datavalue?.value as
      | { latitude?: number; longitude?: number }
      | undefined;

    return {
      id: h.id,
      label: h.label,
      description: h.description,
      classes,
      file,
      typeMatches: wanted.length === 0 ? false : classes.some((c) => wanted.includes(c)),
      thumb: file ? commonsThumb(file, 300) : null,
      lat: typeof coords?.latitude === "number" ? coords.latitude : null,
      lon: typeof coords?.longitude === "number" ? coords.longitude : null,
    };
  });
}

interface ClaimRow {
  mainsnak?: { datavalue?: { value?: unknown } };
}

/** Loose comparison for deciding whether two names are the same name. */
function flatten(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a candidate may be accepted without you looking at it.
 *
 * Both tests have to pass. The type test is the strong one — it is Wikidata's
 * own assertion about what the thing is, and it rules out the failure that
 * matters, a person's name resolving to a book or a place named after them.
 * The name test then guards against the search returning a near neighbour.
 */
export function acceptable(
  candidate: Candidate,
  name: string,
  type: string,
  aliases: string[] = []
): boolean {
  return Boolean(candidate.file) && identifies(candidate, name, type, aliases);
}

/**
 * Whether this record *is* the entity, regardless of whether it has a picture.
 *
 * Split out from the picture question because they are different: a place with
 * no photograph still has coordinates worth keeping, and conflating the two
 * would throw away a confident identification for want of an image.
 */
export function identifies(
  candidate: Candidate,
  name: string,
  type: string,
  aliases: string[] = []
): boolean {
  if (!candidate.typeMatches) return false;

  const label = flatten(candidate.label);
  const forms = new Set(
    [name, ...aliases, ...searchTerms(name, type)].map(flatten).filter(Boolean)
  );
  if (forms.has(label)) return true;

  // A bare surname is not enough to identify anybody: "Netanyahu" matching the
  // label "Benjamin Netanyahu" is only safe because the search ranked it first
  // and the type agreed, so it is allowed — but a one-word *label* answering a
  // multi-word name is not, since that is the direction ambiguity runs in.
  const labelWords = label.split(" ");
  for (const form of forms) {
    const formWords = form.split(" ");
    if (formWords.length === 0) continue;
    const surname = formWords[formWords.length - 1];
    if (
      labelWords.length > 1 &&
      formWords.length === 1 &&
      labelWords[labelWords.length - 1] === surname
    ) {
      return true;
    }
    // "Mohammed bin Salman" against "Mohammed bin Salman Al Saud".
    if (labelWords.length > formWords.length && label.startsWith(`${form} `)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------

export async function store(entityId: number, file: string, wikidata: string): Promise<string> {
  const res = await fetch(commonsThumb(file), { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`Commons returned ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000) throw new Error("That image came back empty.");

  fs.mkdirSync(PORTRAITS_DIR, { recursive: true });
  await fs.promises.writeFile(portraitPath(entityId), buf);
  return file;
}

export interface Outcome {
  state: "hit" | "miss";
  wikidata?: string;
  commons?: string;
  /** Why it was refused, for the run log. */
  note: string;
}

/**
 * The automatic path: look this entity up and keep an image only if nothing is
 * in doubt. Returns what happened rather than throwing, because a miss is an
 * ordinary result and the queue should record it, not retry it.
 */
export async function fetchPortrait(entityId: number): Promise<Outcome> {
  const entity = db()
    .prepare("SELECT id, type, canonical_name FROM entities WHERE id=? AND merged_into IS NULL")
    .get(entityId) as { id: number; type: EntityType; canonical_name: string } | undefined;
  if (!entity) return { state: "miss", note: "No such entity." };

  const aliases = (
    db().prepare("SELECT surface FROM aliases WHERE entity_id=?").all(entityId) as {
      surface: string;
    }[]
  ).map((a) => a.surface);

  const found = await candidates(entity.canonical_name, entity.type);
  if (found.length === 0) {
    setPortraitState(entityId, { portrait: "miss", portraitAt: new Date().toISOString() });
    return { state: "miss", note: "Wikidata has no record under that name." };
  }

  // Identity first. A record we are sure of but which has no picture is still
  // worth keeping — its coordinates are what put the place on a map.
  const known = found.find((c) => identifies(c, entity.canonical_name, entity.type, aliases));
  const where =
    known && known.lat !== null && known.lon !== null
      ? { lat: known.lat, lon: known.lon, zoom: zoomForClasses(known.classes) }
      : {};

  const match = known?.file ? known : undefined;
  if (!match) {
    setPortraitState(entityId, {
      portrait: "miss",
      portraitAt: new Date().toISOString(),
      wikidata: known?.id,
      ...where,
    });
    return {
      state: "miss",
      note: known
        ? where.lat !== undefined
          ? `${known.label} (${known.id}) — no picture, but now placed on the map.`
          : `${known.label} (${known.id}) has no picture.`
        : `${found.length} record(s), none a confident match — pick one by hand if you know it.`,
    };
  }

  await store(entityId, match.file!, match.id);
  setPortraitState(entityId, {
    portrait: "hit",
    portraitAt: new Date().toISOString(),
    wikidata: match.id,
    commons: match.file!,
    portraitBy: undefined,
    ...where,
  });
  return { state: "hit", wikidata: match.id, commons: match.file!, note: `${match.label} (${match.id})` };
}

/** Every located entity, for the map on the pedia list. */
export function locatedEntities(type?: string): {
  id: number;
  name: string;
  type: string;
  lat: number;
  lon: number;
}[] {
  const rows = db()
    .prepare(
      `SELECT id, canonical_name, type, meta_json FROM entities
        WHERE merged_into IS NULL
          AND meta_json LIKE '%"lat"%'
          ${type && type !== "all" ? "AND type = @type" : ""}`
    )
    .all(type && type !== "all" ? { type } : {}) as {
    id: number;
    canonical_name: string;
    type: string;
    meta_json: string;
  }[];

  const out: { id: number; name: string; type: string; lat: number; lon: number }[] = [];
  for (const r of rows) {
    try {
      const m = JSON.parse(r.meta_json) as PortraitState;
      if (typeof m.lat === "number" && typeof m.lon === "number") {
        out.push({ id: r.id, name: r.canonical_name, type: r.type, lat: m.lat, lon: m.lon });
      }
    } catch {
      // A malformed blob is not worth failing a page render over.
    }
  }
  return out;
}

/**
 * Fills in coordinates for entities that were looked up before coordinates
 * were being kept.
 *
 * Cheap enough to be worth doing unconditionally: `wbgetentities` takes fifty
 * ids at a time, so a whole library's backlog is a handful of requests rather
 * than one per entity. Only entities already resolved to a Q-number are
 * touched — this asks a record we have already identified what its coordinates
 * are, it does not identify anything new.
 */
export async function backfillCoords(): Promise<number> {
  const rows = db()
    .prepare(
      `SELECT id, meta_json FROM entities
        WHERE merged_into IS NULL
          AND meta_json LIKE '%"wikidata"%'
          AND meta_json NOT LIKE '%"lat"%'`
    )
    .all() as { id: number; meta_json: string }[];

  const pending: { id: number; q: string }[] = [];
  for (const r of rows) {
    try {
      const q = (JSON.parse(r.meta_json) as PortraitState).wikidata;
      if (q) pending.push({ id: r.id, q });
    } catch {
      /* malformed blob; leave it alone */
    }
  }
  if (pending.length === 0) return 0;

  let filled = 0;
  for (let i = 0; i < pending.length; i += 40) {
    const batch = pending.slice(i, i + 40);
    const data = (await api({
      action: "wbgetentities",
      props: "claims",
      ids: [...new Set(batch.map((b) => b.q))].join("|"),
    })) as { entities?: Record<string, { claims?: Record<string, ClaimRow[]> }> };

    for (const b of batch) {
      const claims = data.entities?.[b.q]?.claims ?? {};
      const coords = claims.P625?.[0]?.mainsnak?.datavalue?.value as
        | { latitude?: number; longitude?: number }
        | undefined;
      if (typeof coords?.latitude !== "number" || typeof coords?.longitude !== "number") continue;

      const classes = (claims.P31 ?? [])
        .map((c) => c.mainsnak?.datavalue?.value)
        .map((v) => (typeof v === "object" && v && "id" in v ? (v as { id: string }).id : null))
        .filter((v): v is string => Boolean(v));

      setPortraitState(b.id, {
        lat: coords.latitude,
        lon: coords.longitude,
        zoom: zoomForClasses(classes),
      });
      filled++;
    }
  }
  return filled;
}
