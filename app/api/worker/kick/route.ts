import { NextResponse } from "next/server";
import { wakeDueRuns } from "@/lib/queue";
import { kickWorker, workerStatus } from "@/lib/worker";

export const dynamic = "force-dynamic";

/**
 * Starts the worker if it is not running, and wakes any run whose timer has
 * passed.
 *
 * This used to happen as a side effect of GET /api/hello and GET /api/runs —
 * the launcher's health probe and the Library page's poll — which was
 * convenient and wrong: a GET that starts token-spending work is a GET any
 * device on the network can use to start it. So it is a POST, behind the LAN
 * token like every other mutation, and the launcher calls it once the port
 * answers. Idempotent: the worker self-deduplicates, and waking a run that is
 * not due changes nothing.
 */
export async function POST() {
  const woken = wakeDueRuns();
  kickWorker();
  return NextResponse.json({ ok: true, woken, worker: workerStatus() });
}
