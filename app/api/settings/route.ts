import { isPlanModel } from "@/lib/claude-models";
import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { getConfig, publicConfig, saveConfig, type Config } from "@/lib/config";
import { OFFERED_PROVIDER_IDS, PROVIDER_IDS, STAGES, type ProviderId, type Stage } from "@/lib/providers";
import { validateKey } from "@/lib/ai/client";
import { addKey, removeKey, reviveKey, setKey } from "@/lib/keys";
import { wakeParkedRuns } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";
import { LAN_COOKIE, lanSettings, setLanEnabled } from "@/lib/lan";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ...publicConfig(), lan: { enabled: lanSettings().enabled } });
}

/**
 * What each preference may be.
 *
 * Settings used to be saved as sent — an hour of 99, a tier of "x" — and the
 * worker read them back as truth: a morning routine that never came due, a
 * pacer with no ceiling. Each check here is the range the reader of that
 * setting can actually act on.
 */
const RULES: {
  [K in keyof Config]?: (v: unknown) => Config[K] | undefined;
} = {
  model: (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined),
  tier: (v) => (v === "free" || v === "paid" ? v : undefined),
  requestsPerMinute: (v) => integer(v, 0, 600),
  keyRetryMinutes: (v) => integer(v, 1, 24 * 60),
  entryThreshold: (v) => integer(v, 1, 50),
  autoRefreshEntries: (v) => (typeof v === "boolean" ? v : undefined),
  defaultBudget: (v) => integer(v, 0, 1_000_000_000),
  morningChores: (v) => (typeof v === "boolean" ? v : undefined),
  feedPolling: (v) => (typeof v === "boolean" ? v : undefined),
  feedReview: (v) => (typeof v === "boolean" ? v : undefined),
  dailyBrief: (v) => (typeof v === "boolean" ? v : undefined),
  briefHours: (v) => integer(v, 1, 24 * 14),
  claudeModel: (v) => (isPlanModel(v) ? v : undefined),
  morningHour: (v) => integer(v, 0, 23),
  // A BCP-47 primary language subtag: "en", "ar", "fr". Region and script
  // are not needed — the writer is told a language, not a locale.
  entryLanguage: (v) =>
    typeof v === "string" && /^[a-z]{2,3}$/i.test(v.trim()) ? v.trim().toLowerCase() : undefined,
};

function integer(v: unknown, min: number, max: number): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

const isProvider = (v: unknown): v is ProviderId =>
  typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);
const isStage = (v: unknown): v is Stage =>
  typeof v === "string" && (STAGES as readonly string[]).includes(v);

export async function POST(req: Request) {
  const body = await readBody<{
    /** Key management. */
    addKey?: string;
    label?: string;
    provider?: ProviderId;
    keyModel?: string;
    baseUrl?: string;
    keyId?: string;
    keyAction?: "remove" | "revive" | "rename" | "disable" | "enable";
    /** Routing. */
    routing?: Partial<Record<Stage, ProviderId>>;
    /** Everything else. */
    model?: string;
    tier?: "free" | "paid";
    requestsPerMinute?: number;
    keyRetryMinutes?: number;
    entryThreshold?: number;
    autoRefreshEntries?: boolean;
    defaultBudget?: number;
    morningChores?: boolean;
    feedPolling?: boolean;
    feedReview?: boolean;
    dailyBrief?: boolean;
    briefHours?: number;
    morningHour?: number;
    entryLanguage?: string;
    /** Reaching this machine from a phone. See lib/lan.ts. */
    lan?: { enabled?: boolean };
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  let note: string | undefined;

  if (body.addKey !== undefined && typeof body.addKey !== "string") {
    return badRequest("addKey must be a string.");
  }
  for (const k of ["label", "keyModel", "baseUrl", "keyId"] as const) {
    if (body[k] !== undefined && typeof body[k] !== "string") return badRequest(`${k} must be a string.`);
  }
  if (body.provider !== undefined && !isProvider(body.provider)) {
    return badRequest("Unknown provider.");
  }

  if (body.addKey?.trim()) {
    const provider = body.provider ?? "gemini";
    // Claude is offered on your plan now, not by the token; see OFFERED_PROVIDER_IDS.
    if (!OFFERED_PROVIDER_IDS.includes(provider)) {
      return badRequest("The Claude API is no longer offered — add Claude (your plan) instead.");
    }
    const check = await validateKey(
      body.addKey.trim(),
      provider,
      body.keyModel?.trim() || undefined,
      body.baseUrl?.trim() || undefined
    );
    if (!check.ok) {
      return NextResponse.json({ error: check.error ?? "Key rejected." }, { status: 400 });
    }
    const added = addKey(body.addKey.trim(), body.label, {
      provider,
      model: body.keyModel,
      baseUrl: body.baseUrl,
    });
    // A key added while everything else is spent should get work moving again.
    // The parked runs are waiting on a guess about when a key would return;
    // one just did, so the guess is void.
    wakeParkedRuns();
    kickWorker();
    note = check.error
      ? `Added “${added.label}” — ${check.error}`
      : `Added “${added.label}”.`;
  }

  if (body.keyId && body.keyAction) {
    switch (body.keyAction) {
      case "remove":
        removeKey(body.keyId);
        note = "Key removed.";
        break;
      case "revive":
        reviveKey(body.keyId);
        wakeParkedRuns();
        kickWorker();
        note = "Key put back in the rotation.";
        break;
      case "rename":
        setKey(body.keyId, { label: body.label ?? "" });
        break;
      case "disable":
        setKey(body.keyId, { disabled: true });
        note = "Key set aside.";
        break;
      case "enable":
        setKey(body.keyId, { disabled: false });
        wakeParkedRuns();
        kickWorker();
        note = "Key back in the rotation.";
        break;
      default:
        return badRequest("Unknown keyAction.");
    }
  }

  const patch: Partial<Config> = {};
  for (const k of Object.keys(RULES) as (keyof typeof RULES)[]) {
    const sent = body[k as keyof typeof body];
    if (sent === undefined) continue;
    const accepted = RULES[k]!(sent);
    if (accepted === undefined) return badRequest(`${k} is out of range.`);
    (patch as Record<string, unknown>)[k] = accepted;
  }

  if (body.routing !== undefined) {
    if (body.routing === null || typeof body.routing !== "object") {
      return badRequest("routing must be an object of stage → provider.");
    }
    for (const [stage, provider] of Object.entries(body.routing)) {
      if (!isStage(stage) || !isProvider(provider)) {
        return badRequest(`routing: unknown stage or provider (${stage}: ${String(provider)}).`);
      }
    }
    // Merge rather than replace, so setting one stage does not clear the rest.
    patch.routing = { ...getConfig().routing, ...body.routing };
    note = "Routing updated.";
  }
  // The free tier's per-minute ceiling is low; keep the pacer honest about it.
  if (body.tier === "free" && body.requestsPerMinute === undefined) patch.requestsPerMinute = 10;
  if (body.tier === "paid" && body.requestsPerMinute === undefined) patch.requestsPerMinute = 120;

  if (Object.keys(patch).length) saveConfig(patch);

  let lan = { enabled: lanSettings().enabled };
  let token: string | null = null;
  if (body.lan !== undefined) {
    if (body.lan === null || typeof body.lan !== "object" || typeof body.lan.enabled !== "boolean") {
      return badRequest("lan.enabled must be true or false.");
    }
    const settings = await setLanEnabled(body.lan.enabled);
    lan = { enabled: settings.enabled };
    token = settings.token;
    note = body.lan.enabled
      ? "LAN mode is on. Restart Corpus to open it to the network; sign a phone in from the link below."
      : "LAN mode is off. Restart Corpus to close it to the network.";
  }

  const res = NextResponse.json({ ...publicConfig(), lan, note });
  // The browser that switched LAN mode on is signed in by the same response,
  // or the very next request from it would be turned away from the page it is
  // looking at.
  if (body.lan?.enabled && token) {
    res.cookies.set(LAN_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return res;
}
