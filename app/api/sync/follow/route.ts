import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { followSettings, followTick, followView, saveFollowSettings } from "@/lib/follow";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/** Where following stands, for the banner on a follower's pages. Never the token. */
export async function GET() {
  return NextResponse.json(followView(), { headers: { "cache-control": "no-store" } });
}

/**
 * The launcher's calls on a follower: `configure` names the Raazi to follow,
 * `tick` takes one step of following (and `resolve` settles a conflict).
 *
 * JSON only, so no web page can drive it from another origin: a cross-origin
 * JSON post has to be allowed first, and nothing here allows it.
 */
export async function POST(req: Request) {
  if (!/^application\/json/i.test(req.headers.get("content-type") ?? "")) {
    return NextResponse.json({ error: "Send JSON." }, { status: 415 });
  }
  const body = await readBody<{ action?: string; url?: string; token?: string; resolve?: string }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  if (body.action === "configure") {
    const url = typeof body.url === "string" ? body.url.trim().replace(/\/+$/, "") : "";
    if (url && !/^https?:\/\//i.test(url)) return badRequest("The address must start with http:// or https://.");
    const current = followSettings();
    const changed = url !== current.primaryUrl;
    saveFollowSettings({
      primaryUrl: url,
      primaryToken: typeof body.token === "string" ? body.token.trim() : current.primaryToken,
      // A different primary is a different library: nothing about the old one carries over.
      ...(changed ? { last: null, offlineSince: null, pulledAt: null } : {}),
    });
    return NextResponse.json(followView());
  }

  if (body.action === "tick") {
    const resolve = body.resolve === "keep-local" || body.resolve === "keep-primary" ? body.resolve : undefined;
    return NextResponse.json(await followTick({ resolve }));
  }

  return badRequest("An action of configure or tick.");
}
