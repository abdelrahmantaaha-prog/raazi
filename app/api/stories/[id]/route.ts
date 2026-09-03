import { NextResponse } from "next/server";
import { asId, badRequest, notFound, optionalId, optionalString, readBody } from "@/lib/http";
import { mergeStories, renameStory, setStoryPinned, splitAccount, storyDetail } from "@/lib/stories";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = asId((await params).id);
  if (!id) return badRequest("Bad story id.");
  const story = storyDetail(id);
  if (!story) return notFound("No such story.");
  return NextResponse.json({ story });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = asId((await params).id);
  if (!id) return badRequest("Bad story id.");
  if (!storyDetail(id)) return notFound("No such story.");

  const body = await readBody<{
    action?: "rename" | "pin" | "split" | "merge";
    title?: string;
    pinned?: boolean;
    sourceId?: number;
    otherId?: number;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  switch (body.action) {
    case "rename": {
      const title = optionalString(body.title);
      if (title === null || !title?.trim()) return badRequest("A story needs a name.");
      renameStory(id, title.trim());
      break;
    }
    case "pin":
      setStoryPinned(id, Boolean(body.pinned));
      break;
    case "split": {
      const sourceId = optionalId(body.sourceId);
      if (!sourceId) return badRequest("Which account should be separated?");
      const belongs = storyDetail(id)!.accounts_list.some((a) => a.id === sourceId);
      if (!belongs) return notFound("That account is not in this story.");
      const moved = splitAccount(sourceId);
      return NextResponse.json({ ok: true, storyId: moved?.storyId });
    }
    case "merge": {
      const otherId = optionalId(body.otherId);
      if (!otherId) return badRequest("Which story should be folded in?");
      if (otherId === id) return badRequest("A story cannot be merged into itself.");
      if (!storyDetail(otherId)) return notFound("No such story to merge.");
      mergeStories(id, otherId);
      break;
    }
    default:
      return badRequest("Unknown action.");
  }

  return NextResponse.json({ story: storyDetail(id) });
}
