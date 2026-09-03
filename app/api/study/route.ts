import { NextResponse } from "next/server";
import {
  accepted,
  badRequest,
  exists,
  inFlight,
  notFound,
  optionalId,
  queryId,
  readBody,
} from "@/lib/http";
import { db } from "@/lib/db";
import { createRun, enqueue } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Leitner intervals in days. A card climbs on a correct answer and drops to
 *  the bottom on a wrong one, which is the whole of the scheduling. */
const INTERVALS = [0, 1, 3, 7, 16, 35, 90];

/**
 * The most cards one request may ask for.
 *
 * Each is a model call against a passage, so an unbounded limit is an
 * unbounded bill: `{"limit": 100000}` was a valid request. Two hundred is more
 * than a sitting's worth and still a bounded amount of work.
 */
const MAX_GENERATE = 200;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tagId = queryId(req, "tag") ?? undefined;
  const mode = url.searchParams.get("mode") === "quiz" ? "quiz" : "card";

  const due = db()
    .prepare(
      `SELECT c.*,
              -- The card's own copies come first; the live rows are only a
              -- fallback for cards made before evidence was stored on them.
              COALESCE(c.entity_name, e.canonical_name) AS entity,
              COALESCE(c.quote, m.quote) AS quote,
              s.title AS source
         FROM cards c
    LEFT JOIN entities e ON e.id = c.entity_id
    LEFT JOIN sources  s ON s.id = c.source_id
    LEFT JOIN mentions m ON m.id = c.mention_id
        WHERE c.kind = @mode
          AND c.due_at <= datetime('now')
          ${tagId ? "AND c.tag_id = @tagId" : ""}
        ORDER BY c.due_at, c.box
        LIMIT 40`
    )
    .all({ mode, ...(tagId ? { tagId } : {}) });

  // Counted through the same filter as the deck. Without the tag clause the
  // header claimed a hundred cards were due while the deck held four.
  const counts = db()
    .prepare(
      `SELECT kind,
              COUNT(*) AS total,
              SUM(CASE WHEN due_at <= datetime('now') THEN 1 ELSE 0 END) AS due,
              SUM(CASE WHEN reviews = 0 THEN 1 ELSE 0 END) AS unseen
         FROM cards
        ${tagId ? "WHERE tag_id = @tagId" : ""}
        GROUP BY kind`
    )
    .all(tagId ? { tagId } : {});

  return NextResponse.json({ due, counts });
}

export async function POST(req: Request) {
  const body = await readBody<{
    action: "generate" | "review";
    tagId?: number;
    entityId?: number;
    limit?: number;
    cardId?: number;
    correct?: boolean;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  if (body.action === "generate") {
    const tagId = optionalId(body.tagId);
    const entityId = optionalId(body.entityId);
    if (tagId === null || entityId === null) return badRequest("tagId and entityId must be ids.");
    if (tagId !== undefined && !exists("tags", tagId)) return notFound("No such tag.");
    if (entityId !== undefined && !exists("entities", entityId)) return notFound("No such entity.");

    const limit = body.limit === undefined ? 24 : body.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_GENERATE) {
      return badRequest(`limit must be a whole number between 1 and ${MAX_GENERATE}.`);
    }

    // One card-making run at a time: they are model calls, and a double click
    // used to pay for the same deck twice.
    const running = inFlight("cards");
    if (running) return accepted(running, "Cards are already being made.");

    const runId = createRun({ kind: "cards", label: "Making study cards" });
    enqueue(runId, [{ kind: "cards", payload: { tagId, entityId, limit } }]);
    kickWorker();
    return NextResponse.json({ runId, note: "Building cards from your sources — this takes a moment." });
  }

  if (body.action === "review") {
    const cardId = optionalId(body.cardId);
    if (!cardId) return badRequest("cardId must be a card id.");
    if (typeof body.correct !== "boolean") return badRequest("correct must be true or false.");

    const card = db().prepare("SELECT box, reviews, lapses FROM cards WHERE id=?").get(cardId) as
      | { box: number; reviews: number; lapses: number }
      | undefined;
    if (!card) return notFound("No such card.");

    const box = body.correct ? Math.min(card.box + 1, INTERVALS.length - 1) : 0;
    const days = INTERVALS[box];
    // A card you got wrong drops to the bottom, where the interval is zero —
    // which made it due again the instant you answered, so it could reappear
    // before you had left the screen. Ten minutes still brings it back this
    // session without putting it straight back in front of you.
    const when = days === 0 ? "+10 minutes" : `+${days} days`;

    db()
      .prepare(
        `UPDATE cards
            SET box=?, reviews=reviews+1, lapses=lapses+?,
                last_result=?, due_at=datetime('now', ?)
          WHERE id=?`
      )
      .run(box, body.correct ? 0 : 1, body.correct ? "right" : "wrong", when, cardId);

    return NextResponse.json({ ok: true, box, nextDue: days });
  }

  return badRequest("Unknown action.");
}

export async function DELETE(req: Request) {
  const id = queryId(req, "id");
  if (id === null) return badRequest("id must be a card id.");
  const gone = db().prepare("DELETE FROM cards WHERE id=?").run(id);
  if (gone.changes === 0) return notFound("No such card.");
  return NextResponse.json({ ok: true });
}
