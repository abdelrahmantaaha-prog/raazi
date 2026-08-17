/**
 * Turning a Gemini failure into a decision.
 *
 * The distinction that matters most: a 429 because you sent 11 requests in a
 * minute is a two-second problem, and a 429 because you burned the day's free
 * quota is a tomorrow problem. Treating them the same either wastes hours of
 * backoff or hammers a dead key for the rest of the day. Google tells them
 * apart in `quotaId` (…PerMinute… vs …PerDay…), so we do too.
 */

export type Disposition =
  /** Transient. Sleep `delayMs`, then retry the same task. */
  | { kind: "retry"; delayMs: number; reason: string }
  /** The key is out of quota for the day. Park the run until `resumeAt`. */
  | { kind: "pause_quota"; resumeAt: Date; reason: string }
  /** The key is bad or absent. Park the run; only the user can fix it. */
  | { kind: "pause_key"; reason: string }
  /** This chunk can't be processed but the run should continue. */
  | { kind: "skip"; reason: string }
  /** The output was truncated. Split the input and requeue as subtasks. */
  | { kind: "split"; reason: string }
  /** Unrecognised. Fail this task, keep the run alive. */
  | { kind: "fail"; reason: string };

export class MissingKeyError extends Error {
  constructor() {
    super("No Gemini API key configured.");
  }
}

/** Every key on the ring is out of quota. Carries the soonest one back. */
export class AllKeysExhaustedError extends Error {
  resumeAt: Date;
  constructor(resumeAt: Date, public readonly count: number) {
    super(
      `All ${count} key${count === 1 ? "" : "s"} are out of quota. The first comes back at ${resumeAt.toLocaleString()}.`
    );
    this.resumeAt = resumeAt;
  }
}

/** Every key was rejected by Google. Only you can fix this. */
export class NoUsableKeysError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class TruncatedOutputError extends Error {
  constructor() {
    super("Model hit its output limit before finishing.");
  }
}

export class SafetyBlockError extends Error {
  constructor(detail: string) {
    super(`Blocked by safety filters: ${detail}`);
  }
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown };
  if (typeof e?.status === "number") return e.status;
  if (typeof e?.code === "number") return e.code;
  const m = /\b(4\d\d|5\d\d)\b/.exec(String((err as Error)?.message ?? ""));
  return m ? Number(m[1]) : undefined;
}

/** The SDK stringifies the error body into `message`; dig the JSON back out. */
function bodyOf(err: unknown): Record<string, unknown> | undefined {
  const raw = err instanceof Error ? err.message : String(err);
  const start = raw.indexOf("{");
  if (start < 0) return undefined;
  try {
    return JSON.parse(raw.slice(start)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

interface QuotaDetail {
  "@type"?: string;
  retryDelay?: string;
  violations?: { quotaId?: string; quotaMetric?: string }[];
}

function detailsOf(err: unknown): QuotaDetail[] {
  const body = bodyOf(err);
  const error = (body?.error ?? body) as { details?: QuotaDetail[] } | undefined;
  return Array.isArray(error?.details) ? error.details : [];
}

/** "41s" / "1.5s" -> milliseconds. */
function parseRetryDelay(details: QuotaDetail[]): number | undefined {
  for (const d of details) {
    if (typeof d.retryDelay === "string") {
      const secs = parseFloat(d.retryDelay.replace(/s$/, ""));
      if (Number.isFinite(secs)) return Math.ceil(secs * 1000);
    }
  }
  return undefined;
}

function quotaIds(details: QuotaDetail[]): string {
  return details
    .flatMap((d) => d.violations ?? [])
    .map((v) => `${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`)
    .join(" ")
    .toLowerCase();
}

/**
 * Gemini's free-tier daily quotas reset at midnight US Pacific, not local
 * midnight — so a run that dies at 9pm Riyadh time is eligible again at 10am,
 * not in three hours. Getting this wrong means the auto-resume fires into a
 * still-exhausted key.
 */
export function nextPacificMidnight(now = new Date()): Date {
  const pacificNow = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
  const offsetMs = now.getTime() - pacificNow.getTime();
  const nextMidnightPacific = new Date(pacificNow);
  nextMidnightPacific.setHours(24, 5, 0, 0); // +5min of slack
  return new Date(nextMidnightPacific.getTime() + offsetMs);
}

/**
 * What one key's failure says about that key, as opposed to what it says about
 * the run. Used by the client to decide whether to set a key aside and reach for
 * the next one.
 */
export type KeyFailure =
  | { kind: "daily"; reason: string }
  | { kind: "rate"; delayMs: number; reason: string }
  | { kind: "invalid"; reason: string }
  | { kind: "other" };

export function keyFailure(err: unknown): KeyFailure {
  const status = statusOf(err);
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const details = detailsOf(err);

  // OpenAI-compatible providers say it in prose rather than in quota metadata.
  // Groq, for instance: "Rate limit reached for model X in organization Y on
  // requests per day (RPD)" — the distinction between that and TPM is the same
  // one that decides whether to wait a minute or set the key aside for a day.
  const httpDelay = (err as { retryAfterMs?: number })?.retryAfterMs;
  if (status === 429 && (httpDelay !== undefined || /rate limit|too many requests/.test(raw))) {
    const perDay = /\b(rpd|requests per day|per day|daily)\b/.test(raw);
    if (perDay) return { kind: "daily", reason: "Daily allowance for this key is spent." };
    if (!/\bquotafailure\b/.test(raw)) {
      return {
        kind: "rate",
        delayMs: httpDelay ?? 30_000,
        reason: "Rate limited for the moment.",
      };
    }
  }

  // 402 means the account needs billing before it will serve anything. The key
  // is genuine — it authenticates — but no amount of waiting will help, so it
  // is set aside like a rejected one rather than retried like a busy one.
  if (status === 402 || raw.includes("payment_required") || raw.includes("payment required")) {
    return {
      kind: "invalid",
      reason: "This account needs billing enabled before it will answer.",
    };
  }

  if (
    status === 401 ||
    status === 403 ||
    raw.includes("api key not valid") ||
    raw.includes("api_key_invalid") ||
    raw.includes("unauthenticated") ||
    raw.includes("permission_denied")
  ) {
    return { kind: "invalid", reason: "The provider rejected this key." };
  }

  if (status === 429 || raw.includes("resource_exhausted") || raw.includes("quota")) {
    const ids = quotaIds(details);
    const perDay = ids.includes("perday") || raw.includes("per day");
    const perMinute = ids.includes("perminute") || ids.includes("persecond");
    const delay = parseRetryDelay(details);

    // Only Google explicitly saying "per day" is treated as a spent allowance.
    if (perDay) return { kind: "daily", reason: "Daily quota for this key is spent." };

    // Everything else — including a bare 429 with no quota metadata at all — is
    // assumed to be a short window. Guessing "daily" here was costing whole
    // keys for the rest of the day over what was often a per-minute burst, and
    // being wrong the optimistic way only costs one wasted call.
    return {
      kind: "rate",
      delayMs: delay ?? (perMinute ? 30_000 : 60_000),
      reason: perMinute
        ? "Rate limited for the moment."
        : "Rate limited, with no window given — assuming a short one.",
    };
  }

  return { kind: "other" };
}

const MAX_ATTEMPTS = 5;

export function classify(err: unknown, attempts: number): Disposition {
  if (err instanceof MissingKeyError) {
    return { kind: "pause_key", reason: "No API key configured." };
  }
  if (err instanceof NoUsableKeysError) {
    return { kind: "pause_key", reason: err.message };
  }
  // The client already tried every key before giving up, so there is nothing
  // to gain by retrying sooner than the first one coming back.
  if (err instanceof AllKeysExhaustedError) {
    return { kind: "pause_quota", resumeAt: err.resumeAt, reason: err.message };
  }
  if (err instanceof TruncatedOutputError) {
    return { kind: "split", reason: "Output hit the token limit; splitting input." };
  }
  if (err instanceof SafetyBlockError) {
    return { kind: "skip", reason: err.message };
  }
  // Not every task talks to a model. The picture lookup talks to Wikidata,
  // whose 429 clears in seconds — matched by name so this module keeps no
  // dependency on the one that raises it.
  if (err instanceof Error && err.name === "RateLimited") {
    return { kind: "retry", delayMs: 60_000, reason: err.message };
  }

  const status = statusOf(err);
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const details = detailsOf(err);

  if (status === 401 || status === 403 || raw.includes("api key not valid") ||
      raw.includes("unauthenticated") || raw.includes("permission_denied")) {
    return { kind: "pause_key", reason: "Gemini rejected the API key." };
  }

  if (status === 429 || raw.includes("resource_exhausted") || raw.includes("quota")) {
    const ids = quotaIds(details);
    const perDay = ids.includes("perday") || raw.includes("per day");
    const perMinute = ids.includes("perminute") || ids.includes("persecond");
    const delay = parseRetryDelay(details);

    // A per-minute violation, or any 429 carrying a short retryDelay, is a
    // rate limit — wait it out rather than parking the run for the day.
    if (!perDay && (perMinute || (delay !== undefined && delay <= 120_000))) {
      return {
        kind: "retry",
        delayMs: delay ?? 30_000,
        reason: "Rate limited; waiting for the window to clear.",
      };
    }
    // Reached only when a quota error surfaces outside the key ring's own
    // rotation. Park for an hour rather than until tomorrow, to match the
    // policy the ring applies to individual keys — a run that slept until
    // midnight while its keys came back at ten would be the worst of both.
    return {
      kind: "pause_quota",
      resumeAt: new Date(Date.now() + 60 * 60_000),
      reason: perDay
        ? "Daily quota is spent. Trying again in an hour in case it frees up sooner."
        : "Quota refused with no window given; trying again in an hour.",
    };
  }

  if (status === 400 && (raw.includes("safety") || raw.includes("blocked"))) {
    return { kind: "skip", reason: "Content blocked by safety filters." };
  }

  if (status !== undefined && status >= 500) {
    if (attempts >= MAX_ATTEMPTS) {
      return { kind: "fail", reason: `Gemini kept returning ${status}.` };
    }
    return {
      kind: "retry",
      delayMs: Math.min(2 ** attempts * 1000, 60_000),
      reason: `Gemini returned ${status}; backing off.`,
    };
  }

  // Network blips look like generic fetch failures.
  if (raw.includes("fetch failed") || raw.includes("econnreset") ||
      raw.includes("etimedout") || raw.includes("socket hang up")) {
    if (attempts >= MAX_ATTEMPTS) {
      return { kind: "fail", reason: "Network kept failing." };
    }
    return {
      kind: "retry",
      delayMs: Math.min(2 ** attempts * 1000, 60_000),
      reason: "Network error; retrying.",
    };
  }

  if (attempts >= 2) {
    return {
      kind: "fail",
      reason: err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400),
    };
  }
  return { kind: "retry", delayMs: 2000, reason: "Unrecognised error; one more try." };
}

/** Human-readable one-liner for the Library page. */
export function explain(d: Disposition): string {
  switch (d.kind) {
    case "pause_quota":
      return `${d.reason} Resumes automatically after ${d.resumeAt.toLocaleString()}.`;
    case "pause_key":
      return `${d.reason} Add a working key in Settings, then resume.`;
    default:
      return d.reason;
  }
}
