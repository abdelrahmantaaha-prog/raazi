import { NextResponse } from "next/server";
import { badRequest, readBody, tooLarge } from "@/lib/http";
import { AlreadyReadError, clipArticle, clipVerdict } from "@/lib/clip";
import { heldCount } from "@/lib/triage";

export const dynamic = "force-dynamic";

/**
 * The browser extension's one call: this page, as I see it, into the inbox.
 *
 * Answers with CORS headers for an extension origin only. A Chromium
 * extension with host permission for this address is not subject to CORS at
 * all, so these are for the day it is loaded without one; no web page is ever
 * allowed to post here from a different origin. In LAN mode the middleware
 * has already checked the token before this runs.
 */
const MAX_CLIP = 4 * 1024 * 1024;

function cors(req: Request, res: NextResponse): NextResponse {
  const origin = req.headers.get("origin") ?? "";
  if (/^(chrome|moz|edge)-extension:\/\//.test(origin)) {
    res.headers.set("access-control-allow-origin", origin);
    res.headers.set("access-control-allow-headers", "content-type, x-corpus-token, authorization");
    res.headers.set("access-control-allow-methods", "POST, OPTIONS");
    res.headers.set("vary", "origin");
  }
  return res;
}

export async function OPTIONS(req: Request) {
  return cors(req, new NextResponse(null, { status: 204 }));
}

export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_CLIP) return cors(req, tooLarge(MAX_CLIP));

  const body = await readBody<{
    url?: string;
    title?: string;
    text?: string;
    author?: string | null;
    publishedAt?: string | null;
    outlet?: string | null;
    image?: string | null;
    lang?: string | null;
  }>(req);
  if (body === null) return cors(req, badRequest("Malformed JSON body."));
  if (typeof body.url !== "string" || typeof body.text !== "string") {
    return cors(req, badRequest("url and text are required."));
  }
  if (body.text.length > MAX_CLIP) return cors(req, tooLarge(MAX_CLIP));
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 2000) : null);

  try {
    const result = clipArticle({
      url: body.url,
      title: typeof body.title === "string" ? body.title : body.url,
      text: body.text,
      author: str(body.author),
      publishedAt: str(body.publishedAt),
      outlet: str(body.outlet),
      image: str(body.image),
      lang: str(body.lang),
    });
    return cors(
      req,
      NextResponse.json({
        ...result,
        verdict: clipVerdict(body.text),
        held: heldCount(),
        note: result.replaced
          ? "That address was already waiting; its text has been replaced with what you sent."
          : "In the inbox, with the full text.",
      })
    );
  } catch (err) {
    if (err instanceof AlreadyReadError) {
      return cors(
        req,
        NextResponse.json({ error: err.message, sourceId: err.sourceId }, { status: 409 })
      );
    }
    return cors(req, badRequest((err as Error).message.slice(0, 300)));
  }
}
