import { NextResponse } from "next/server";
import { badRequest, readBody, tooLarge } from "@/lib/http";
import {
  AlreadyReadError,
  GatherError,
  clipArticle,
  clipVerdict,
  gatherQuotes,
  sourceForUrl,
  type ClipResult,
} from "@/lib/clip";
import { heldCount } from "@/lib/triage";

export const dynamic = "force-dynamic";

/**
 * The browser extension's call: this page, as I see it, into the inbox — and,
 * when words on it were marked, those words onto a draft.
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
    /** Words marked on the page, for a draft's shelf. */
    quotes?: unknown;
    /** The draft they go to. */
    draftId?: unknown;
    /** False for a second quote from a page already sent: no second copy of the article. */
    clip?: boolean;
  }>(req);
  if (body === null) return cors(req, badRequest("Malformed JSON body."));
  if (typeof body.url !== "string" || typeof body.text !== "string") {
    return cors(req, badRequest("url and text are required."));
  }
  if (body.text.length > MAX_CLIP) return cors(req, tooLarge(MAX_CLIP));
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 2000) : null);

  const quotes = Array.isArray(body.quotes)
    ? body.quotes.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    : [];
  const draftId =
    typeof body.draftId === "number" && Number.isInteger(body.draftId) && body.draftId > 0 ? body.draftId : null;
  if (quotes.length && draftId === null) return cors(req, badRequest("Say which draft the quotes go to."));

  let result: ClipResult | null = null;
  let sourceId: number | null = body.clip === false ? sourceForUrl(body.url) : null;
  let alreadyRead = false;

  if (sourceId === null) {
    try {
      result = clipArticle({
        url: body.url,
        title: typeof body.title === "string" ? body.title : body.url,
        text: body.text,
        author: str(body.author),
        publishedAt: str(body.publishedAt),
        outlet: str(body.outlet),
        image: str(body.image),
        lang: str(body.lang),
      });
      sourceId = result.sourceId;
    } catch (err) {
      if (err instanceof AlreadyReadError) {
        // Already read: nothing to send, but a quote from it is still a quote.
        if (!quotes.length) {
          return cors(req, NextResponse.json({ error: err.message, sourceId: err.sourceId }, { status: 409 }));
        }
        sourceId = err.sourceId;
        alreadyRead = true;
      } else {
        return cors(req, badRequest((err as Error).message.slice(0, 300)));
      }
    }
  }

  let gathered: ReturnType<typeof gatherQuotes> | null = null;
  if (quotes.length && draftId !== null && sourceId !== null) {
    try {
      gathered = gatherQuotes(draftId, sourceId, quotes);
    } catch (err) {
      if (err instanceof GatherError) {
        return cors(req, NextResponse.json({ error: err.message, sourceId, clipped: Boolean(result) }, { status: 404 }));
      }
      throw err;
    }
  }

  const articleNote = alreadyRead
    ? "the article was already in your library"
    : result?.replaced
      ? "that address was already waiting, and its text has been replaced with what you sent"
      : result
        ? "the article is in the inbox, with the full text"
        : "the article was already sent";

  return cors(
    req,
    NextResponse.json({
      ...(result ?? { itemId: null, words: 0, chunks: 0, replaced: false }),
      sourceId,
      alreadyRead,
      verdict: clipVerdict(body.text),
      held: heldCount(),
      gathered: gathered?.gathered ?? 0,
      skipped: gathered?.skipped ?? 0,
      draft: gathered ? { id: gathered.draftId, title: gathered.draftTitle } : null,
      note: gathered
        ? `${gathered.gathered ? `${gathered.gathered} quote${gathered.gathered === 1 ? "" : "s"} on "${gathered.draftTitle}"` : `Already on "${gathered.draftTitle}"`}; ${articleNote}.`
        : result?.replaced
          ? "That address was already waiting; its text has been replaced with what you sent."
          : "In the inbox, with the full text.",
    })
  );
}
