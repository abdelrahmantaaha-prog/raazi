import { NextResponse } from "next/server";

/**
 * The two checks every mutating route needs and most of them skipped.
 *
 * `Number(params.id)` on junk gives NaN, better-sqlite3 binds NaN as NULL,
 * `WHERE id=NULL` matches nothing — so `POST /api/mentions/abc` answered
 * `{ok:true}` having done nothing, and the client's optimistic update showed a
 * state that was never persisted. And an unguarded `req.json()` turns a
 * malformed body into a 500, which reads as "the app broke" when the truth is
 * "the request was wrong".
 */

/** A route id param, or null when it is not a real row id. */
export function asId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The JSON body, or null when there isn't one worth the name. */
export async function readBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}
