import os from "node:os";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { lanEnabled } from "@/lib/lan";

export const dynamic = "force-dynamic";

/**
 * "Is there a Raazi here?"
 *
 * The Android helper finds this machine by asking every address on the local
 * subnet this question at once. That makes the answer's job narrow: it has to
 * be cheap enough to serve two hundred times over, and distinctive enough that
 * a reply cannot be confused with some other service that happens to sit on the
 * same port. Hence the literal `app` marker rather than inferring from shape.
 *
 * It is the one route the LAN-mode middleware leaves open, deliberately: it
 * reports what the library contains, not anything from inside it, and a phone
 * has to be able to find the machine before it can sign in to it. `lan` tells
 * the phone whether it will need a token next.
 *
 * A GET does nothing but answer. It used to start the worker as a side effect,
 * which meant a subnet sweep from any device — or a stranger's curl — set
 * token-spending work in motion; that now takes POST /api/worker/kick.
 */
export async function GET() {
  let library = { sources: 0, entities: 0, entries: 0 };
  try {
    library = db()
      .prepare(
        `SELECT (SELECT COUNT(*) FROM sources) AS sources,
                (SELECT COUNT(*) FROM entities WHERE merged_into IS NULL) AS entities,
                (SELECT COUNT(*) FROM entries) AS entries`
      )
      .get() as typeof library;
  } catch {
    // A machine still opening its database is still a Raazi worth listing.
  }

  return NextResponse.json(
    {
      app: "corpus",
      // Baked in at build (next.config.ts): a launcher starts this server with
      // node directly, so npm's variable is not there, and an update is judged
      // by this answer naming the release it promised.
      version: process.env.RAAZI_RELEASE ?? "0.1.0",
      host: os.hostname(),
      port: Number(process.env.PORT ?? 5400),
      lan: lanEnabled(),
      library,
    },
    // Discovery answers must never be served from a cache: the whole point is
    // that they reflect this machine, right now.
    { headers: { "cache-control": "no-store" } }
  );
}
