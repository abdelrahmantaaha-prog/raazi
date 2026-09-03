import { NextResponse } from "next/server";
import { badRequest, exists, notFound, optionalId, optionalString, queryId, readBody } from "@/lib/http";
import { db } from "@/lib/db";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";
import { retrieve } from "@/lib/pipeline/ask";

export const dynamic = "force-dynamic";

/**
 * Questions whose task died without writing an answer.
 *
 * The handler records the answer on success; a task that fails outright — a
 * key that never came back, a run retried past its limit — leaves the row
 * saying "pending" for ever, and the page shows a spinner over a question
 * nothing is working on. Reconciled here rather than in the worker because a
 * run can also be abandoned by a restart, which no handler is present for.
 */
function settleAbandoned(): void {
  db()
    .prepare(
      `UPDATE questions
          SET state = 'failed',
              error = COALESCE((
                SELECT t.last_error FROM tasks t
                 WHERE t.kind = 'ask'
                   AND json_extract(t.payload_json, '$.questionId') = questions.id
                 ORDER BY t.id DESC LIMIT 1
              ), 'The run this question was in did not finish.')
        WHERE state = 'pending'
          AND EXISTS (
            SELECT 1 FROM tasks t JOIN runs r ON r.id = t.run_id
             WHERE t.kind = 'ask'
               AND json_extract(t.payload_json, '$.questionId') = questions.id
               AND t.state = 'failed'
          )
          AND NOT EXISTS (
            SELECT 1 FROM tasks t2
             WHERE t2.kind = 'ask'
               AND json_extract(t2.payload_json, '$.questionId') = questions.id
               AND t2.state IN ('pending','running')
          )`
    )
    .run();
}

export async function GET() {
  settleAbandoned();
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
  const question = optionalString(parsed.question);
  if (question === null) return badRequest("question must be a string.");
  if (!question?.trim()) {
    return NextResponse.json({ error: "Ask something." }, { status: 400 });
  }
  // A tag id that was never a tag is a foreign-key error on the insert, which
  // used to surface as a 500 on a request that was simply wrong.
  const tagId = optionalId(parsed.tagId);
  if (tagId === null) return badRequest("tagId must be a tag id.");
  if (tagId !== undefined && !exists("tags", tagId)) return notFound("No such tag.");

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
  const id = queryId(req, "id");
  if (id === null) return badRequest("id must be a question id.");
  const gone = db().prepare("DELETE FROM questions WHERE id=?").run(id);
  if (gone.changes === 0) return notFound("No such question.");
  return NextResponse.json({ ok: true });
}
