import { NextResponse } from "next/server";
import { db } from "./db";

/**
 * The checks every mutating route needs and most of them skipped.
 *
 * `Number(params.id)` on junk gives NaN, better-sqlite3 binds NaN as NULL,
 * `WHERE id=NULL` matches nothing — so `POST /api/mentions/abc` answered
 * `{ok:true}` having done nothing, and the client's optimistic update showed a
 * state that was never persisted. And an unguarded `req.json()` turns a
 * malformed body into a 500, which reads as "the app broke" when the truth is
 * "the request was wrong".
 *
 * The same rule applies one level down: a write to a row that does not exist
 * must say so. `UPDATE … WHERE id=?` on a missing id is a successful statement
 * that changed nothing, and an insert that references a missing parent is a
 * foreign-key error that surfaces as a 500. Both are answered here with the
 * status they deserve — 404 — so the client can tell "gone" from "broken".
 */

/** A route id param, or null when it is not a real row id. */
export function asId(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * An id carried in the body or the query string.
 *
 * `undefined` when the field was simply absent — an optional foreign key that
 * the caller left out — and `null` when something was sent that is not a row
 * id, so the route can answer 400 rather than quietly binding NULL.
 */
export function optionalId(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  return asId(raw);
}

/** A query-string id, e.g. `?note=12`, or null when absent or not a row id. */
export function queryId(req: Request, name: string): number | null {
  return asId(new URL(req.url).searchParams.get(name));
}

/** The JSON body, or null when there isn't one worth the name. */
export async function readBody<T>(req: Request): Promise<T | null> {
  try {
    const parsed = (await req.json()) as unknown;
    // A bare string or number parses as JSON but is not a body any route
    // knows how to read; treating it as one is how `body.title.trim()` on
    // `42` became a 500.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * A string field from a body, or undefined when it was not sent.
 *
 * Anything that is present but not a string is reported as `null`, so the
 * caller can refuse it: `{"title": 42}` is a wrong request, not a blank title.
 */
export function optionalString(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  return typeof raw === "string" ? raw : null;
}

export function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export function notFound(error = "Not found.") {
  return NextResponse.json({ error }, { status: 404 });
}

export function conflict(error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status: 409 });
}

/**
 * Tables a route may check a parent in before writing a child row. A fixed
 * list rather than a free string because the name is interpolated into SQL.
 */
const TABLES = [
  "sources",
  "chunks",
  "entities",
  "mentions",
  "tags",
  "runs",
  "drafts",
  "ideas",
  "cards",
  "questions",
  "bookmarks",
] as const;
export type Table = (typeof TABLES)[number];

/** Whether a row with this id exists. */
export function exists(table: Table, id: number): boolean {
  if (!TABLES.includes(table)) throw new Error(`Unknown table ${table}`);
  return Boolean(db().prepare(`SELECT 1 AS x FROM ${table} WHERE id=?`).get(id));
}

/**
 * The run already doing this, if there is one.
 *
 * Every button that spends tokens — refresh, fact-check, enhance, generate —
 * used to queue again on a double click, and the worker's own sweep was the
 * only thing with a guard. A task of this kind that is pending or running in
 * an open run, with the same target in its payload, means the click has
 * already been honoured; the route answers 202 with that run instead.
 *
 * `target` is matched field by field inside the task's JSON payload with
 * json_extract — exact, so `draftId: 5` no longer matches draft 50.
 */
export function inFlight(
  kind: string,
  target: Record<string, number | string | null | undefined> = {}
): number | null {
  const clauses: string[] = [];
  const params: unknown[] = [kind];
  for (const [key, value] of Object.entries(target)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) throw new Error(`Bad payload key ${key}`);
    clauses.push(`json_extract(t.payload_json, '$.${key}') IS ?`);
    params.push(value ?? null);
  }
  const row = db()
    .prepare(
      `SELECT t.run_id FROM tasks t JOIN runs r ON r.id = t.run_id
        WHERE t.kind = ? AND t.state IN ('pending','running')
          AND r.state IN ('queued','running','paused_quota','paused_key','paused_budget')
          ${clauses.map((c) => `AND ${c}`).join(" ")}
        ORDER BY t.run_id DESC LIMIT 1`
    )
    .get(...params) as { run_id: number } | undefined;
  return row?.run_id ?? null;
}

/** "Already under way" — the run that is doing it, and no new one. */
export function accepted(runId: number, note: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ runId, inFlight: true, note, ...extra }, { status: 202 });
}

/**
 * The size of a body a route will accept.
 *
 * Checked against the declared length before anything is read, and against the
 * bytes actually received afterwards — a client that lies about the first
 * still cannot get past the second.
 */
export function tooLarge(limitBytes: number) {
  return NextResponse.json(
    { error: `That is larger than the ${Math.round(limitBytes / (1024 * 1024))} MB this route accepts.` },
    { status: 413 }
  );
}

/**
 * A Content-Disposition value that survives any title.
 *
 * HTTP headers are Latin-1; a title with an Arabic word in it threw from inside
 * the response constructor and the export failed with no download at all. The
 * plain `filename` carries an ASCII rendering for old clients and the RFC 5987
 * `filename*` carries the real name, UTF-8 and percent-encoded, which every
 * current browser prefers when both are present.
 */
export function attachment(filename: string, fallback = "download"): string {
  const stripped = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "")
    .trim();
  // A title that is entirely non-Latin strips down to its extension alone,
  // and ".docx" is not a name.
  const ascii = /^[^.]/.test(stripped) ? stripped : fallback;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
