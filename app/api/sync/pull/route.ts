import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { pullFrom, reachable } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

/**
 * Make this library a copy of a peer's.
 *
 * Two callers: the Settings page here ("pull from my other laptop"), which
 * sends one address, and a peer that was told to push, which sends every
 * address it has and lets this side find the one that answers.
 */
export async function POST(req: Request) {
  const body = await readBody<{ url?: string; addresses?: string[]; token?: string; force?: boolean }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return badRequest("The peer's token is needed.");
  const addresses = [
    ...(typeof body.url === "string" && body.url.trim() ? [body.url.trim()] : []),
    ...(Array.isArray(body.addresses) ? body.addresses.filter((a): a is string => typeof a === "string") : []),
  ].filter((a) => /^https?:\/\//i.test(a));
  if (!addresses.length) return badRequest("An address to pull from is needed.");

  try {
    const peer = addresses.length === 1 ? { url: addresses[0], token } : await reachable(addresses, token);
    const result = await pullFrom(peer, { force: Boolean(body.force) });
    return NextResponse.json(result);
  } catch (err) {
    const message = (err as Error).message;
    const status = /already the same|changed since the last sync/.test(message) ? 409 : 500;
    return NextResponse.json({ error: message.slice(0, 500) }, { status });
  }
}
