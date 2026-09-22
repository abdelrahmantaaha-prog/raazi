import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import {
  SWITCH_EXIT,
  activeDiscipline,
  addDiscipline,
  chooseDiscipline,
  forgetDiscipline,
  listDisciplines,
  pinnedDir,
  renameDiscipline,
} from "@/lib/disciplines";

export const dynamic = "force-dynamic";

/**
 * The disciplines, and which one is open.
 *
 * Opening another one is a restart, not a switch: this process settled which
 * library it was working in when it started — the database handle, the
 * worker, every path — and the only way to be certain none of that leaks into
 * the next discipline is not to keep the process. So the choice is written
 * down, the answer goes back, and then the server exits with SWITCH_EXIT for
 * the launcher to start it again on the other folder.
 *
 * The exit is deferred past the response: exiting inside the handler would
 * close the socket before the browser had the JSON telling it to wait.
 */

function state() {
  return {
    disciplines: listDisciplines().map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt })),
    active: activeDiscipline().id,
    /** A copy pointed at one library cannot have disciplines at all. */
    pinned: Boolean(pinnedDir()),
  };
}

export async function GET() {
  return NextResponse.json(state());
}

export async function POST(req: Request) {
  const body = await readBody<{ action?: unknown; id?: unknown; name?: unknown }>(req);
  if (body === null) return badRequest("Malformed JSON body.");
  const id = typeof body.id === "string" ? body.id : "";
  const name = typeof body.name === "string" ? body.name : "";

  try {
    switch (body.action) {
      case "add": {
        const made = addDiscipline(name);
        return NextResponse.json({ ...state(), added: made.id });
      }
      case "rename": {
        renameDiscipline(id, name);
        return NextResponse.json(state());
      }
      case "forget": {
        forgetDiscipline(id);
        return NextResponse.json(state());
      }
      case "open": {
        const chosen = chooseDiscipline(id);
        if (pinnedDir()) return badRequest("This copy is pointed at a single library.");
        // Long enough for the response to be written and the socket flushed,
        // short enough that the window is waiting rather than wondering.
        setTimeout(() => process.exit(SWITCH_EXIT), 400);
        return NextResponse.json({ ...state(), opening: chosen.name, restarting: true });
      }
      default:
        return badRequest("Unknown action.");
    }
  } catch (err) {
    return badRequest((err as Error).message);
  }
}
