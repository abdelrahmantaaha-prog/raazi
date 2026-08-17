import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { db } from "@/lib/db";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";
import { retrieve } from "@/lib/pipeline/ask";

export const dynamic = "force-dynamic";

export async function GET() {
  const questions = db()
    .prepare(
      `SELECT q.*, t.name AS tag_name FROM questions q
    LEFT JOIN tags t ON t.id = q.tag_id
       ORDER BY q.id DESC LIMIT 50`
    )
    .all();
  return NextResponse.json({ questions });
}

export async function POST(req: Request) {
  const parsed = await readBody<{ question: string; tagId?: number }>(req);
  if (parsed === null) return badRequest("Malformed JSON body.");
  const { question, tagId } = parsed;
  if (!question?.trim()) {
    return NextResponse.json({ error: "Ask something." }, { status: 400 });
  }

  // Told up front how much the library has, so an empty answer is never a
  // surprise after a minute of waiting.
  const found = retrieve(question, tagId, 60).length;

  const id = Number(
    db()
      .prepare("INSERT INTO questions (question, tag_id, state) VALUES (?, ?, 'pending')")
      .run(question.trim(), tagId ?? null).lastInsertRowid
  );

  const runId = createRun({ kind: "ask", label: question.trim().slice(0, 60) });
  enqueue(runId, [{ kind: "ask", payload: { questionId: id } }]);
  kickWorker();

  return NextResponse.json({ id, runId, passages: found });
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id") ?? 0);
  if (id) db().prepare("DELETE FROM questions WHERE id=?").run(id);
  return NextResponse.json({ ok: true });
}
