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
  /** Transient. Sleep `delayMs`, then retry the same task.
   *
   *  `free` means the wait says nothing about this task — the ring was busy,
   *  or a rate limit was in force — so it must not be charged against the
   *  task's attempts. See refundAttempt in lib/queue.ts. */
  | { kind: "retry"; delayMs: number; reason: string; free?: boolean }
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

/**
 * One MODEL is out of quota, and the call cannot be served by another.
 *
 * Raised only for a call with a hard pin — embeddings, where no text model is
 * a substitute. When that model refuses there is nothing to fall back to, and
 * nothing to gain by asking the next key either: on the free tier the
 * allowance belongs to the model and every key draws on the same one. Asking
 * anyway is how one refused call could set aside every key on the ring and
 * take the reading down with it for the next hour. (Mutarjim met exactly this
 * on its figure redraw, 9 September 2026; the fix is the same here.)
 */
export class ModelExhaustedError extends Error {
  resumeAt: Date;
  constructor(
    public readonly model: string,
    resumeAt: Date,
    /** What the provider itself said, kept for the log. */
    public readonly reason: string,
    /** The free tier's allowance for this model is zero — not spent, absent.
     *  Waiting will not help; only billing will. */
    public readonly noFreeTier: boolean = false
  ) {
    super(
      noFreeTier
        ? `The free tier gives ${model} no allowance at all (limit 0), so waiting will not help; ` +
            `it needs billing enabled on the key's account. The keys themselves are fine and every other stage carries on.`
        : `${model} is out of quota for the day. The keys themselves are fine and every other stage carries on; ` +
            `this one resumes after ${resumeAt.toLocaleString()}.`
    );
    this.resumeAt = resumeAt;
  }
}

/**
 * Did the provider say the free allowance for this model is ZERO, rather than
 * spent?
 *
 * Gemini words both as "You exceeded your current quota", and the difference
 * matters entirely: a spent allowance comes back tomorrow, while `limit: 0`
 * means this model is not on the free tier at all and no amount of waiting
 * will change it.
 */
export function noFreeTierQuota(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return /limit:\s*0\b/.test(raw);
}

/** Every key was rejected by Google. Only you can fix this. */
export class NoUsableKeysError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Every provider that could answer this call is unavailable *right now* — the
 * cloud is answering 503 for everyone, or a local model's endpoint is not
 * listening, or both. The keys are fine and the work is fine; the services are
 * momentarily out.
 *
 * This is deliberately distinct from AllKeysExhausted (quota spent) and
 * NoUsableKeys (misconfigured), because the right response is different: wait a
 * short while and try again, without failing the task and without parking the
 * run for hours. It exists because when Gemini went busy for a stretch and a
 * local Ollama key was on the ring with nothing listening behind it, every task
 * spun through gemini-503 → ollama-refused → retry as fast as the queue would
 * turn — thousands of failed requests a minute. That storm, not the outage,
 * was what took the process down.
 */
export class ProvidersBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvidersBusyError";
  }
}

/**
 * A connection that could never be established, as opposed to a server that
 * answered with an error. The local model's port with nothing behind it is the
 * case that matters: it means "this provider is not here", so its key should
 * come off the ring for a while rather than be dialed again on the next task.
 */
export function isConnRefused(err: unknown): boolean {
  const e = err as { cause?: { code?: string }; code?: string };
  const code = String(e?.cause?.code ?? e?.code ?? "");
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    /econnrefused|enotfound|eai_again|fetch failed|other side closed|connection refused/.test(raw)
  );
}

/**
 * A call this app gave up on because it ran past its own ceiling.
 *
 * Kept apart from the network blips it is otherwise grouped with because of
 * what it means on the local model: a nine-billion-parameter model handed
 * the extraction schema does not fail, it takes four minutes, and a task that
 * waited three of them five times over is a task that was failed for good by
 * a provider that was only ever the last resort.
 */
export function isTimeout(err: unknown): boolean {
  const e = err as { name?: string; cause?: { name?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return true;
  if (e?.cause?.name === "TimeoutError" || e?.cause?.name === "AbortError") return true;
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /operation was aborted|timeouterror|the operation timed out|timed out\b|etimedout/.test(raw);
}

export class TruncatedOutputError extends Error {
  constructor() {
    super("Model hit its output limit before finishing.");
  }
}

/**
 * The model could not produce the schema it was asked for.
 *
 * Distinct from a bad request, and distinct from a key problem: the request is
 * well formed and the key is fine, but this particular model cannot hold the
 * shape. A local model asked for the rich extraction schema does this: it
 * spends its output budget reasoning and never closes the object. Rotating
 * keys inside that provider is pointless (every key reaches the same model);
 * the answer is the next provider, which is what the router does with this.
 */
export class SchemaUnsupportedError extends Error {
  constructor(readonly detail: string) {
    super("This model could not produce the requested JSON shape.");
    this.name = "SchemaUnsupportedError";
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
 * A 403 that is about a file, not about the key.
 *
 * The Files API hands back a URI that only the uploading key can read, and
 * asking for it with any other key — or with the pool, which picks a fresh
 * key per request — gets PERMISSION_DENIED with the file named in the
 * message. That is the caller's mistake, and classifying it as "the provider
 * rejected this key" marked every local key invalid, permanently, on the
 * first busy minute of a transcription.
 */
function isFilePermissionError(status: number | undefined, raw: string): boolean {
  if (status !== 403 && !raw.includes("permission_denied")) return false;
  return /\bfile\b|\bfiles\/|fileuri|file_uri|generativelanguage\.googleapis\.com\/v1beta\/files/.test(raw);
}

/**
 * Whether the provider refused because its model could not produce the shape.
 *
 * Some endpoints say so explicitly; a model that returns an empty completion for a
 * structured call has done the same thing without saying it.
 */
export function isSchemaFailure(status: number | undefined, raw: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return (
    raw.includes("json_validate_failed") ||
    raw.includes("failed to validate json") ||
    raw.includes("failed_generation")
  );
}

/**
 * The service is up but will not serve right now.
 *
 * Distinct from every other failure here in one way that decides what to do
 * about it: it is not about the key. Gemini's free tier answers 503 "high
 * demand" for whole afternoons, and it answers it to every key you own,
 * because they all reach the same overloaded model. Rotating thirty-five keys
 * through it is thirty-five wasted round trips to the same answer.
 *
 * So the router skips the provider rather than the key, and lands on whatever
 * is behind it — which is why the local model is on the end of every chain.
 */
export function isProviderUnavailable(err: unknown): boolean {
  const status = statusOf(err);
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (status === 502 || status === 503 || status === 504) return true;
  return (
    raw.includes("overloaded") ||
    raw.includes("high demand") ||
    raw.includes("unavailable") ||
    raw.includes("model is currently experiencing")
  );
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
  // An OpenAI-shaped endpoint, for instance: "Rate limit reached for model X on
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

  // Not the key's fault, and no other key can fix it — see the helper.
  if (isFilePermissionError(status, raw)) return { kind: "other" };
  if (isSchemaFailure(status, raw)) return { kind: "other" };

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

/** How long a task waits when every service is momentarily out. Long enough
 *  that an outage is a trickle of checks, not a storm; short enough that work
 *  resumes promptly once a provider is back. */
const PROVIDERS_BUSY_DELAY_MS = 120_000;

export function classify(err: unknown, attempts: number): Disposition {
  if (err instanceof MissingKeyError) {
    return { kind: "pause_key", reason: "No API key configured." };
  }
  // The services are momentarily out, not the keys. Wait a couple of minutes
  // and try the same task again — never failing it, so a long outage does not
  // burn through its attempts, and never spinning, so an outage cannot become
  // the request storm that used to crash the worker.
  if (err instanceof ProvidersBusyError) {
    return { kind: "retry", delayMs: PROVIDERS_BUSY_DELAY_MS, reason: err.message, free: true };
  }
  if (err instanceof NoUsableKeysError) {
    return { kind: "pause_key", reason: err.message };
  }
  // The client already tried every key before giving up, so there is nothing
  // to gain by retrying sooner than the first one coming back.
  if (err instanceof AllKeysExhaustedError) {
    return { kind: "pause_quota", resumeAt: err.resumeAt, reason: err.message };
  }
  // The model is spent, not the ring. Every key stays available for the rest
  // of the pipeline meanwhile — which is the whole point of this error.
  if (err instanceof ModelExhaustedError) {
    console.log(`[corpus] ${err.model} refused: ${err.reason}`);
    // A model the free tier gives nothing at all will not come back by
    // waiting, so the task is settled rather than parked to retry forever.
    return err.noFreeTier
      ? { kind: "skip", reason: err.message }
      : { kind: "pause_quota", resumeAt: err.resumeAt, reason: err.message };
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
    return { kind: "retry", delayMs: 60_000, reason: err.message, free: true };
  }

  const status = statusOf(err);
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const details = detailsOf(err);

  // A file the key cannot read is this task's problem, not the ring's:
  // parking the whole run for a key nobody needs to replace would be wrong.
  if (isFilePermissionError(status, raw)) {
    return {
      kind: "fail",
      reason: "The provider refused access to the uploaded file — it belongs to a different key. " +
        (err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)),
    };
  }

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
        free: true,
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

  // Network blips look like generic fetch failures. A call this app aborted
  // because it ran past its own timeout belongs here too: the request was
  // fine and the answer was slow, which is a reason to try again rather than
  // to give up on the passage — a long entry against a busy provider is
  // exactly the call that trips it.
  if (raw.includes("fetch failed") || raw.includes("econnreset") ||
      raw.includes("etimedout") || raw.includes("socket hang up") ||
      raw.includes("operation was aborted") || raw.includes("aborterror") ||
      raw.includes("timeouterror") || raw.includes("the operation timed out")) {
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
