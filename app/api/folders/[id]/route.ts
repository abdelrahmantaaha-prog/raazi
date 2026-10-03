import { NextResponse } from "next/server";
import { asId, badRequest, notFound, readBody } from "@/lib/http";
import { folderFiles, getFolder, readFolder, removeFolder, renameFolder, setFileState } from "@/lib/folders";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const folder = getFolder(id);
  if (!folder) return notFound("No such folder.");
  return NextResponse.json({ folder, files: folderFiles(id) });
}

/**
 * read: queue the waiting files (or the ones named) to become sources.
 * skip / unskip: leave one file out of "read all", or put it back.
 * rename: the folder's name.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (!getFolder(id)) return notFound("No such folder.");
  const body = await readBody<{ action?: string; fileIds?: number[]; fileId?: number; name?: string }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  switch (body.action) {
    case "read": {
      const ids = Array.isArray(body.fileIds) ? body.fileIds.filter((n) => Number.isInteger(n)) : undefined;
      const { runId, queued } = readFolder(id, ids);
      if (!queued) return badRequest("Nothing waiting to read.");
      kickWorker();
      return NextResponse.json({ runId, queued });
    }
    case "skip":
    case "unskip": {
      const fileId = asId(body.fileId ?? null);
      if (fileId === null) return badRequest("fileId required.");
      setFileState(fileId, body.action === "skip" ? "skipped" : "waiting");
      break;
    }
    case "rename":
      if (typeof body.name !== "string") return badRequest("name required.");
      renameFolder(id, body.name);
      break;
    default:
      return badRequest("Unknown action.");
  }
  return NextResponse.json({ folder: getFolder(id), files: folderFiles(id) });
}

/** Removes the folder and its unread files. Sources already read from it stay. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (!getFolder(id)) return notFound("No such folder.");
  removeFolder(id);
  return NextResponse.json({ ok: true });
}
