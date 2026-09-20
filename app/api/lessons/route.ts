import { NextResponse } from "next/server";
import { badRequest, notFound, optionalString, queryId, readBody } from "@/lib/http";
import {
  addLesson,
  isLessonStage,
  LESSON_STAGES,
  lessonsHeldBack,
  listLessons,
  MAX_LESSONS_PER_CALL,
  removeLesson,
  updateLesson,
} from "@/lib/lessons";

export const dynamic = "force-dynamic";

function payload() {
  const heldBack: Record<string, number> = {};
  for (const s of LESSON_STAGES) if (s !== "all") heldBack[s] = lessonsHeldBack(s);
  return { lessons: listLessons(), stages: LESSON_STAGES, cap: MAX_LESSONS_PER_CALL, heldBack };
}

/** Every lesson, with how many per stage are past the cap and so not sent. */
export async function GET() {
  return NextResponse.json(payload());
}

/** Adds a lesson in your words. `stage` is one of the stages or "all". */
export async function POST(req: Request) {
  const body = await readBody<{ stage?: string; text?: string; why?: string }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  const text = optionalString(body.text);
  if (!text?.trim()) return badRequest("A lesson needs words.");
  const stage = body.stage ?? "all";
  if (!isLessonStage(stage)) return badRequest(`stage must be one of ${LESSON_STAGES.join(", ")}.`);
  const lesson = addLesson({ stage, text, why: optionalString(body.why) ?? null });
  return NextResponse.json({ lesson, ...payload() });
}

/** Edits a lesson, or switches it on or off. */
export async function PATCH(req: Request) {
  const body = await readBody<{ id?: number; text?: string; why?: string | null; stage?: string; active?: boolean }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return badRequest("Which lesson?");
  if (body.stage !== undefined && !isLessonStage(body.stage)) return badRequest("Not a stage.");
  try {
    if (!updateLesson(id, body)) return notFound("No such lesson.");
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }
  return NextResponse.json(payload());
}

/** Removes a lesson of yours; a shipped one is switched off instead. */
export async function DELETE(req: Request) {
  const id = queryId(req, "id");
  if (!id) return badRequest("Which lesson?");
  if (!removeLesson(id)) return notFound("No such lesson.");
  return NextResponse.json(payload());
}
