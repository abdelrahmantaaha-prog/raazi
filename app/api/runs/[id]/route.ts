import { NextResponse } from "next/server";
import { asId, badRequest, exists, notFound, readBody } from "@/lib/http";
import { db } from "@/lib/db";
import { getRun, pauseRun, resumeRun, retryFailedTasks } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const runId = asId((await ctx.params).id);
  if (runId === null) return badRequest("Not a valid id.");
  const parsed = await readBody<{
    action: "pause" | "resume" | "retry" | "budget";
    budgetCap?: number | null;
  }>(req);
  if (parsed === null) return badRequest("Malformed JSON body.");
  const { action, budgetCap } = parsed;
  if (!exists("runs", runId)) return notFound("No such run.");

  switch (action) {
    case "pause":
      pauseRun(runId, "paused_user", "Paused by you.");
      break;

    case "resume":
      // You pressed the button: that is the force a user-paused run waits for.
      resumeRun(runId, { force: true });
      kickWorker();
      break;

    case "retry": {
      const n = retryFailedTasks(runId);
      kickWorker();
      return NextResponse.json({ run: getRun(runId), retried: n });
    }

    case "budget": {
      if (
        budgetCap !== undefined &&
        budgetCap !== null &&
        (typeof budgetCap !== "number" || !Number.isFinite(budgetCap) || budgetCap < 0)
      ) {
        return badRequest("budgetCap must be a non-negative number, or null for no cap.");
      }
      db()
        .prepare("UPDATE runs SET budget_cap=? WHERE id=?")
        .run(budgetCap && budgetCap > 0 ? Math.floor(budgetCap) : null, runId);
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

    default:
      return badRequest("Unknown action.");
  }

  return NextResponse.json({ run: getRun(runId) });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const runId = asId((await ctx.params).id);
  if (runId === null) return badRequest("Not a valid id.");
  const run = getRun(runId);
  if (!run) return notFound("No such run.");
  const tasks = db()
    .prepare(
      "SELECT id, seq, kind, state, attempts, last_error, tokens_in, tokens_out, model, updated_at FROM tasks WHERE run_id=? ORDER BY seq, id"
    )
    .all(runId);
  return NextResponse.json({ run, tasks });
}
