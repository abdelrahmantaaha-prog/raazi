import os from "node:os";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/**
 * "Is there a Corpus here?"
 *
 * The Android helper finds this machine by asking every address on the local
 * subnet this question at once. That makes the answer's job narrow: it has to
 * be cheap enough to serve two hundred times over, and distinctive enough that
 * a reply cannot be confused with some other service that happens to sit on the
 * same port. Hence the literal `app` marker rather than inferring from shape.
 *
 * There is no authentication, deliberately: it reports what the library
 * contains, not anything from inside it, and it is only reachable by whoever is
 * already on the network.
 */
export async function GET() {
  // The launcher probes this at boot, which makes it the one route guaranteed
  // to run before any page is opened. Kicking here is what arms the morning
  // timer and resumes pending work on a headless start — and it is idempotent,
  // so the Android helper sweeping a subnet costs one no-op call per probe.
  kickWorker();

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
    // A machine still opening its database is still a Corpus worth listing.
  }

  return NextResponse.json(
    {
      app: "corpus",
      version: process.env.npm_package_version ?? "0.1.0",
      host: os.hostname(),
      port: Number(process.env.PORT ?? 5400),
      library,
    },
    // Discovery answers must never be served from a cache: the whole point is
    // that they reflect this machine, right now.
    { headers: { "cache-control": "no-store" } }
  );
}
