import { NextResponse } from "next/server";
import { accepted, badRequest, inFlight } from "./http";
import { canSearchWeb } from "./ai/client";
import { createRun, enqueue } from "./queue";
import { kickWorker } from "./worker";
import type { TextTarget } from "./web-checks";

/**
 * Queues a check of a draft or a source on the open web. Asked for by hand
 * only: it searches on your plan's allowance. One at a time per text.
 */
export function startTextWebcheck(target: TextTarget, id: number, title: string): NextResponse {
  if (!canSearchWeb()) return badRequest("Checking on the web needs Claude (your plan). Add it in Settings first.");
  const running = inFlight("webcheck_text", { target, id });
  if (running) return accepted(running, "This is already being checked.");
  const runId = createRun({ kind: "webcheck", label: `Web check: ${title}` });
  enqueue(runId, [{ kind: "webcheck_text", payload: { target, id } }]);
  kickWorker();
  return NextResponse.json({ runId });
}
