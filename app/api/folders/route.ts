import { NextResponse } from "next/server";
import { badRequest, readBody, tooLarge } from "@/lib/http";
import { createFolder, folderFromZip, listFolders } from "@/lib/folders";

export const dynamic = "force-dynamic";

/** A zip is read into memory whole, so it has a ceiling; a folder sent file by file does not. */
const MAX_ZIP = 1024 * 1024 * 1024;

export async function GET() {
  return NextResponse.json({ folders: listFolders() });
}

/**
 * Starts a folder: from a zip sent whole (multipart, field "zip"), which is
 * unpacked into it at once; or empty, by name (JSON), for a folder whose files
 * follow one at a time to /api/folders/[id]/files. Nothing is read either way.
 */
export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_ZIP) return tooLarge(MAX_ZIP);
    const form = await req.formData();
    const file = form.get("zip");
    if (!(file instanceof File)) return badRequest("No zip received.");
    if (file.size > MAX_ZIP) return tooLarge(MAX_ZIP);
    try {
      const made = folderFromZip(file.name, Buffer.from(await file.arrayBuffer()));
      return NextResponse.json(made);
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message || "Could not open that zip." }, { status: 400 });
    }
  }
  const body = await readBody<{ name?: string }>(req);
  if (body === null || typeof body.name !== "string" || !body.name.trim()) return badRequest("name required.");
  return NextResponse.json({ folderId: createFolder(body.name, "folder") });
}
