/**
 * The shared key pool, as seen from here.
 *
 * Corpus owns the thirty-seven keys in the sense that they are in its config
 * file, but every other project in the folder wants them too, and a key that
 * corpus discovers is spent at nine is still the first thing basma-scanner
 * reaches for at ten. keybroker (../keybroker) holds the ring instead and
 * hands out one door to it.
 *
 * From the ring's point of view the broker is simply another key, listed first:
 * the same rotation, the same cooldowns, the same `usableKeys` filter. What
 * makes it different is only where it points — /gemini for the native API,
 * /v1 for the OpenAI-shaped one — and that its state is never written to
 * config.json, because a broker is not something you own a key for.
 *
 * The local ring stays exactly where it was, behind it. If the broker is
 * unreachable the call falls through to the keys on this machine, which is the
 * whole reason they were left in place.
 */

import { readStore } from "./config-file";
import type { ApiKey } from "./keys";

export interface BrokerSettings {
  url: string;
  token: string;
}

const BROKER_GEMINI = "broker-gemini";
const BROKER_GROQ = "broker-groq";

export const isBrokerKey = (id: string) => id.startsWith("broker-");

/**
 * Where the broker is. The environment wins, so a run can be pointed at a
 * different one without touching settings; otherwise it comes from
 * data/config.json, which is where the desktop app can actually set it.
 */
export function brokerSettings(): BrokerSettings | undefined {
  const stored = readStore<{ broker?: Partial<BrokerSettings> & { enabled?: boolean } }>();
  const url = (process.env.BROKER_URL ?? stored.broker?.url ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.BROKER_TOKEN ?? stored.broker?.token ?? "").trim();
  if (!url || !token) return undefined;
  if (stored.broker?.enabled === false && !process.env.BROKER_URL) return undefined;
  return { url, token };
}

/**
 * Quota state for the broker keys, held in memory rather than on disk.
 *
 * A cooldown on a real key is worth persisting — it is still spent after a
 * restart. A cooldown on the broker means "the broker was unreachable a minute
 * ago", which a restart is exactly the sort of thing to have fixed.
 */
const transient: Record<string, Partial<ApiKey>> = {};

export function patchBrokerKey(id: string, patch: Partial<ApiKey>) {
  transient[id] = { ...transient[id], ...patch };
}

/** Forgets what the broker did, without waiting for a restart. For tests, and
 *  for a settings page that has just been given a different broker. */
export function clearBrokerState() {
  for (const id of Object.keys(transient)) delete transient[id];
}

/** The synthetic ring entries. Listed before the local keys, so the pool is
 *  tried first and this machine's own keys are the fallback. */
export function brokerKeys(): ApiKey[] {
  const settings = brokerSettings();
  if (!settings) return [];
  const base = (id: string, provider: ApiKey["provider"], baseUrl: string): ApiKey => ({
    id,
    label: "Shared key pool",
    key: settings.token,
    provider,
    baseUrl,
    ...transient[id],
  });
  return [
    base(BROKER_GEMINI, "gemini", `${settings.url}/gemini`),
    base(BROKER_GROQ, "groq", `${settings.url}/v1`),
  ];
}

/**
 * Whether a failure means "the broker is down" rather than "the model said no".
 *
 * The broker stamps everything it relayed, and names its own errors
 * broker_auth / broker_not_found, so the two are told apart rather than
 * guessed at. A model refusing a prompt must not send the run back to the
 * local keys — it would only be refused there too.
 *
 * Status codes on their own say nothing here, because the broker relays
 * Google's and Groq's answers byte for byte: a 404 is almost always a retired
 * model name, and a 5xx is the provider having a bad minute — both of which
 * this machine's own keys would get too. Only a 5xx in the broker's own error
 * shape (its body names the broker) is the broker itself failing. Cloudflare
 * fronting the Worker also answers 502/503/504 in its own HTML when the
 * Worker cannot be reached, and that HTML names Cloudflare, not the broker —
 * so an unreachable Worker is caught by the network branch below on the next
 * attempt rather than parking the pool on a page of markup.
 */
export function brokerIsDown(err: unknown): boolean {
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status = statusOf(err);
  if (raw.includes("broker_auth") || raw.includes("broker_not_found")) return true;
  if ((status === 502 || status === 503 || status === 504) && raw.includes("broker")) return true;
  return (
    raw.includes("fetch failed") ||
    raw.includes("econnrefused") ||
    raw.includes("econnreset") ||
    raw.includes("etimedout") ||
    raw.includes("socket hang up") ||
    raw.includes("network")
  );
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown };
  if (typeof e?.status === "number") return e.status;
  const m = /^\s*(\d{3})\b/.exec(err instanceof Error ? err.message : String(err));
  return m ? Number(m[1]) : undefined;
}

/**
 * When the pool says it will have something again.
 *
 * A broker_exhausted answer carries `retryAt` — the moment the first of its
 * keys comes back — in the body and in an x-broker-retry-at header. The body
 * is what survives into an SDK error message, so that is read first; the
 * OpenAI adapter copies the header onto the error as `retryAt` for the case
 * where the body was cut short. Absent both, the caller falls back to its own
 * flat wait.
 */
export function brokerRetryAt(err: unknown): Date | undefined {
  const fromHeader = (err as { retryAt?: unknown })?.retryAt;
  if (typeof fromHeader === "string") {
    const d = new Date(fromHeader);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const raw = err instanceof Error ? err.message : String(err);
  const m = /"retryAt"\s*:\s*"([^"]+)"/.exec(raw);
  if (!m) return undefined;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
