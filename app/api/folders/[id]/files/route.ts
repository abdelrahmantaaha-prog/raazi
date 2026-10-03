import { NextResponse } from "next/server";
import { asId, badRequest, notFound, tooLarge } from "@/lib/http";
import { addToFolder, getFolder } from "@/lib/folders";

export const dynamic = "force-dynamic";

const MAX_FILE = 500 * 1024 * 1024;

/** One file of a folder you are bringing in, with its path inside the folder. Lands; is not read. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  if (!getFolder(id)) return notFound("No such folder.");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_FILE) return tooLarge(MAX_FILE);
  const form = await req.formData();
  const file = form.get("file");
  const rel = String(form.get("path") ?? "");
  if (!(file instanceof File) || !rel) return badRequest("file and path required.");
  if (file.size > MAX_FILE) return tooLarge(MAX_FILE);
  const landed = addToFolder(id, rel, Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ landed });
}
