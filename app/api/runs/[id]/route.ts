import { NextResponse } from "next/server";
import { asId, badRequest, readBody } from "@/lib/http";
import { db } from "@/lib/db";
import { getRun, pauseRun, resumeRun, retryFailedTasks } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const runId = asId((await ctx.params).id);
  if (runId === null) return badRequest("Not a valid id.");
  const parsed = await readBody<{
    action: "pause" | "resume" | "retry" | "budget";
    budgetCap?: number;
  }>(req);
  if (parsed === null) return badRequest("Malformed JSON body.");
  const { action, budgetCap } = parsed;

  switch (action) {
    case "pause":
      pauseRun(runId, "paused_user", "Paused by you.");
      break;

    case "resume":
      resumeRun(runId);
      kickWorker();
      break;

    case "retry": {
      const n = retryFailedTasks(runId);
      kickWorker();
      return NextResponse.json({ run: getRun(runId), retried: n });
    }

    case "budget":
      db()
        .prepare("UPDATE runs SET budget_cap=? WHERE id=?")
        .run(budgetCap && budgetCap > 0 ? budgetCap : null, runId);
      // Raising a cap on a run parked at its old one should get it going again.
      if (
        (db().prepare("SELECT state FROM runs WHERE id=?").get(runId) as { state: string })?.state ===
        "paused_budget"
      ) {
        resumeRun(runId);
        kickWorker();
      }
      break;
  }

  return NextResponse.json({ run: getRun(runId) });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const runId = asId((await ctx.params).id);
  if (runId === null) return badRequest("Not a valid id.");
  const tasks = db()
    .prepare(
      "SELECT id, seq, kind, state, attempts, last_error, tokens_in, tokens_out, updated_at FROM tasks WHERE run_id=? ORDER BY seq, id"
    )
    .all(runId);
  return NextResponse.json({ run: getRun(runId), tasks });
}
