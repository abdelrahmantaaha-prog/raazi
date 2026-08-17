import { NextResponse } from "next/server";
import { asId, badRequest, readBody } from "@/lib/http";
import {
  addPoint,
  deleteIdea,
  deletePoint,
  draftFromIdea,
  getIdea,
  listIdeas,
  movePoint,
  updateIdea,
  updatePoint,
  type IdeaState,
} from "@/lib/ideas";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const idea = getIdea(id);
  if (!idea) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(idea);
}

/**
 * Everything an outline needs, on one route.
 *
 * The alternative was five routes for add / edit / move / remove / promote,
 * each a couple of lines, and a client that has to remember which verb goes
 * where. An action field is plainer to read at both ends.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const body = await readBody<{
    action: "update" | "add-point" | "update-point" | "move-point" | "delete-point" | "to-draft";
    title?: string;
    note?: string;
    state?: IdeaState;
    pointId?: number;
    text?: string;
    depth?: number;
    quote?: string | null;
    citation?: string | null;
    direction?: -1 | 1;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  switch (body.action) {
    case "update":
      updateIdea(id, { title: body.title, note: body.note, state: body.state });
      break;

    case "add-point":
      addPoint(id, body.text ?? "", body.depth);
      break;

    case "update-point":
      if (!body.pointId) return NextResponse.json({ error: "pointId required" }, { status: 400 });
      updatePoint(body.pointId, {
        text: body.text,
        depth: body.depth,
        quote: body.quote,
        citation: body.citation,
      });
      break;

    case "move-point":
      if (!body.pointId) return NextResponse.json({ error: "pointId required" }, { status: 400 });
      movePoint(body.pointId, body.direction === -1 ? -1 : 1);
      break;

    case "delete-point":
      if (!body.pointId) return NextResponse.json({ error: "pointId required" }, { status: 400 });
      deletePoint(body.pointId);
      break;

    case "to-draft": {
      const draftId = draftFromIdea(id);
      if (!draftId) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json({ draftId, idea: getIdea(id), ideas: listIdeas() });
    }
  }

  return NextResponse.json({ idea: getIdea(id), ideas: listIdeas() });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  deleteIdea(id);
  return NextResponse.json({ ok: true, ideas: listIdeas() });
}
