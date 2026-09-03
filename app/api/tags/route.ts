import { NextResponse } from "next/server";
import { badRequest, optionalString, readBody } from "@/lib/http";
import { db, tx } from "@/lib/db";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";
import { ensureTag, listTags } from "@/lib/tags";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ tags: listTags() });
}

export async function POST(req: Request) {
  const body = await readBody<{
    action?: "create" | "fileUntagged";
    name?: string;
    description?: string;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  // Bulk-file everything that arrived before you started using tags, or that
  // the model declined to file the first time.
  if (body.action === "fileUntagged") {
    const untagged = db()
      .prepare(
        `SELECT s.id, s.title FROM sources s
          WHERE NOT EXISTS (SELECT 1 FROM source_tags st WHERE st.source_id = s.id)
            AND EXISTS (SELECT 1 FROM chunks c WHERE c.source_id = s.id)`
      )
      .all() as { id: number; title: string }[];

    if (!untagged.length) {
      return NextResponse.json({ queued: 0, note: "Everything with text is already filed." });
    }

    // One filing pass at a time: a second click while the first is still
    // queued would file every source twice.
    const pending = db()
      .prepare(
        `SELECT t.run_id FROM tasks t JOIN runs r ON r.id = t.run_id
          WHERE t.kind='tag' AND t.state IN ('pending','running')
            AND r.state IN ('queued','running') LIMIT 1`
      )
      .get() as { run_id: number } | undefined;
    if (pending) {
      return NextResponse.json(
        { runId: pending.run_id, queued: 0, inFlight: true, note: "Filing is already under way." },
        { status: 202 }
      );
    }

    const runId = createRun({ kind: "tag", label: `Filing ${untagged.length} source(s)` });
    tx(() => {
      enqueue(
        runId,
        untagged.map((s) => ({ kind: "tag" as const, payload: { sourceId: s.id } }))
      );
    });
    kickWorker();
    return NextResponse.json({ runId, queued: untagged.length });
  }

  const name = optionalString(body.name);
  const description = optionalString(body.description);
  if (name === null || description === null) return badRequest("name and description must be strings.");
  if (!name?.trim()) {
    return NextResponse.json({ error: "A tag needs a name." }, { status: 400 });
  }
  const id = ensureTag(name, description);
  return NextResponse.json({ id, tags: listTags() });
}
