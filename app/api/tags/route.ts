import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
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

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "A tag needs a name." }, { status: 400 });
  }
  const id = ensureTag(body.name, body.description);
  return NextResponse.json({ id, tags: listTags() });
}
