import { NextResponse } from "next/server";
import { asId, badRequest, notFound, optionalId, optionalString, readBody } from "@/lib/http";
import {
  addPoint,
  asDepth,
  deleteIdea,
  deletePoint,
  draftFromIdea,
  getIdea,
  isIdeaState,
  listIdeas,
  movePoint,
  pointOf,
  updateIdea,
  updatePoint,
  type IdeaState,
} from "@/lib/ideas";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const idea = getIdea(id);
  if (!idea) return notFound("No such idea.");
  return NextResponse.json(idea);
}

/**
 * Everything an outline needs, on one route.
 *
 * The alternative was five routes for add / edit / move / remove / promote,
 * each a couple of lines, and a client that has to remember which verb goes
 * where. An action field is plainer to read at both ends.
 *
 * A point named in the body must belong to the idea named in the URL. Without
 * that check any idea's URL could edit or delete any other idea's outline.
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
  if (!getIdea(id)) return notFound("No such idea.");

  const title = optionalString(body.title);
  const note = optionalString(body.note);
  const text = optionalString(body.text);
  if (title === null || note === null || text === null) {
    return badRequest("title, note and text must be strings.");
  }
  const quote = body.quote === null ? null : optionalString(body.quote);
  const citation = body.citation === null ? null : optionalString(body.citation);
  if ((quote === null && body.quote !== null) || (citation === null && body.citation !== null)) {
    return badRequest("quote and citation must be strings.");
  }
  if (body.state !== undefined && !isIdeaState(body.state)) return badRequest("Unknown state.");
  if (body.depth !== undefined && asDepth(body.depth) === undefined) {
    return badRequest("depth must be 0, 1 or 2.");
  }

  /** The point in the body, if it is one of this idea's. */
  const point = () => {
    const pointId = optionalId(body.pointId);
    if (!pointId) return { error: badRequest("pointId required") };
    const row = pointOf(id, pointId);
    if (!row) return { error: notFound("No such point in this idea.") };
    return { row };
  };

  switch (body.action) {
    case "update":
      updateIdea(id, { title, note, state: body.state });
      break;

    case "add-point":
      addPoint(id, text ?? "", body.depth);
      break;

    case "update-point": {
      const p = point();
      if ("error" in p) return p.error;
      updatePoint(p.row.id, { text, depth: body.depth, quote, citation });
      break;
    }

    case "move-point": {
      const p = point();
      if ("error" in p) return p.error;
      movePoint(p.row.id, body.direction === -1 ? -1 : 1);
      break;
    }

    case "delete-point": {
      const p = point();
      if ("error" in p) return p.error;
      deletePoint(p.row.id);
      break;
    }

    case "to-draft": {
      const draftId = draftFromIdea(id);
      if (!draftId) return notFound("No such idea.");
      return NextResponse.json({ draftId, idea: getIdea(id), ideas: listIdeas() });
    }

    default:
      return badRequest("Unknown action.");
  }

  return NextResponse.json({ idea: getIdea(id), ideas: listIdeas() });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (!getIdea(id)) return notFound("No such idea.");
  deleteIdea(id);
  return NextResponse.json({ ok: true, ideas: listIdeas() });
}
