import path from "node:path";
import { readShared, writeShared } from "../config-file";

/**
 * Keys for the research tools a web check can use (research/mcp-server.mjs).
 *
 * Kept apart from the ring in lib/keys.ts, which is for the models that read
 * and write: these are not rotated, metered or routed, they are simply handed
 * to the tool server for the length of a check. Shared by every discipline,
 * like the model keys. The browser only ever sees whether one is set.
 */

export type ResearchKeyId =
  | "opensanctions"
  | "opencorporates"
  | "aleph"
  | "opensky"
  | "youtube"
  | "reddit"
  | "gfw"
  | "courtlistener";

export interface ResearchService {
  id: ResearchKeyId;
  label: string;
  /** What having it adds, in plain words. */
  adds: string;
  signUp: string;
  /** Without it the tool is off; with "better", the tool works and the key improves it. */
  needed: "required" | "better";
  /** Reddit's key is two parts. */
  hint?: string;
}

export const RESEARCH_SERVICES: ResearchService[] = [
  {
    id: "opensanctions",
    label: "OpenSanctions",
    adds: "Sanctions lists, politically exposed persons and watchlists worldwide.",
    signUp: "https://www.opensanctions.org/api/",
    needed: "required",
  },
  {
    id: "opencorporates",
    label: "OpenCorporates",
    adds: "Company registries worldwide, and the directorships a named person holds.",
    signUp: "https://opencorporates.com/api_accounts/new",
    needed: "required",
  },
  {
    id: "aleph",
    label: "OCCRP Aleph",
    adds: "Leaked documents, company registers and customs records, searched together — where a private contract, invoice or batch number can turn up.",
    signUp: "https://aleph.occrp.org/",
    needed: "required",
    hint: "Sign in, then copy the API key from your profile settings.",
  },
  {
    id: "opensky",
    label: "OpenSky Network",
    adds: "Past flights of an aircraft, and arrivals and departures at an airport — the cargo flights behind a shipment.",
    signUp: "https://opensky-network.org/my-opensky/account",
    needed: "required",
    hint: "An API client's id and secret, joined by a colon: id:secret",
  },
  {
    id: "gfw",
    label: "Global Fishing Watch",
    adds: "A ship's history of names, flags and owners. Without it, ships are still looked up by their register entry.",
    signUp: "https://globalfishingwatch.org/our-apis/tokens",
    needed: "better",
  },
  {
    id: "youtube",
    label: "YouTube",
    adds: "Searching speeches, interviews and press conferences on YouTube.",
    signUp: "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
    needed: "required",
  },
  {
    id: "reddit",
    label: "Reddit",
    adds: "Searching public Reddit posts.",
    signUp: "https://www.reddit.com/prefs/apps",
    needed: "required",
    hint: "The app's id and secret, joined by a colon: id:secret",
  },
  {
    id: "courtlistener",
    label: "CourtListener",
    adds: "More searches of US court records per day. They work without it.",
    signUp: "https://www.courtlistener.com/sign-in/",
    needed: "better",
  },
];

const isId = (v: unknown): v is ResearchKeyId => RESEARCH_SERVICES.some((s) => s.id === v);

function stored(): Partial<Record<ResearchKeyId, string>> {
  return (readShared<{ researchKeys?: Partial<Record<ResearchKeyId, string>> }>().researchKeys ?? {}) as Partial<
    Record<ResearchKeyId, string>
  >;
}

/** Sets or, with an empty value, removes one key. */
export function setResearchKey(id: string, value: string): boolean {
  if (!isId(id)) return false;
  const next = { ...stored() };
  const v = value.trim();
  if (v) next[id] = v;
  else delete next[id];
  writeShared({ ...readShared(), researchKeys: next });
  return true;
}

/** For the tool server only — never sent to the browser. */
export function researchKeys(): Partial<Record<ResearchKeyId, string>> {
  return stored();
}

/** What Settings shows: each service, and whether its key is set. */
export function publicResearchKeys() {
  const keys = stored();
  return RESEARCH_SERVICES.map((s) => ({
    ...s,
    set: Boolean(keys[s.id]),
    tail: keys[s.id] ? `…${keys[s.id]!.slice(-4)}` : null,
  }));
}

/**
 * Where the tool server is. Both a checkout and the packaged copy run with
 * the app's own folder as the working directory, and the packaged copy carries
 * research/ beside its server (scripts/dist.mjs).
 */
export function researchServerPath(): string {
  return path.join(process.cwd(), "research", "mcp-server.mjs");
}
