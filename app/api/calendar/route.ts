import { NextResponse } from "next/server";
import { asId, badRequest, notFound, readBody } from "@/lib/http";
import { dismissCalendar, listCalendar, logCalendar, refileCalendar } from "@/lib/calendar";

export const dynamic = "force-dynamic";

/** The calendar as the page draws it. */
export async function GET() {
  return NextResponse.json(listCalendar());
}

/**
 * Two things, neither of which costs a token.
 *
 * `refresh` files every date in the sources of the last N days, for a library
 * that has articles the brief never ran over — or for a fresh install of the
 * calendar on a library that already has a month of reading in it.
 *
 * `dismiss` hides a line you do not need to watch; `restore` brings it back.
 */
export async function POST(req: Request) {
  const body = await readBody<{ action?: "refresh" | "dismiss" | "restore"; days?: number; id?: number }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  if (body.action === "refresh") {
    const days = Number.isInteger(body.days) && body.days! > 0 && body.days! <= 366 ? body.days! : 30;
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    // Filing re-reads what is already there under the current rules before it
    // adds anything, so a refresh is also how a mis-filed year gets corrected.
    const moved = refileCalendar();
    const added = logCalendar(from, to, "refresh");
    return NextResponse.json({ added, moved, days, ...listCalendar() });
  }

  if (body.action === "dismiss" || body.action === "restore") {
    const id = asId(body.id);
    if (id === null) return badRequest("Say which line.");
    if (!dismissCalendar(id, body.action === "dismiss")) return notFound("No such line on the calendar.");
    return NextResponse.json({ ok: true, ...listCalendar() });
  }

  return badRequest("An action of refresh, dismiss or restore.");
}
