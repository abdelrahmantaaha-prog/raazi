import { NextResponse } from "next/server";
import { badRequest, notFound, queryId } from "@/lib/http";
import { forgetDiscard, libraryCorrections } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** The standing corrections you marked as applying to the whole library. */
export async function GET() {
  return NextResponse.json({ corrections: libraryCorrections() });
}

/**
 * Dropping one.
 *
 * This also releases whatever passage it was suppressing, which is the honest
 * behaviour: the verdict and the block are the same decision, and a UI that let
 * you delete the reason while the passage stayed hidden would leave you with a
 * library holding a rule nothing records.
 */
export async function DELETE(req: Request) {
  const id = queryId(req, "id");
  if (id === null) return badRequest("id must be a correction id.");
  if (!forgetDiscard(id)) return notFound("No such correction.");
  return NextResponse.json({ ok: true, corrections: libraryCorrections() });
}
