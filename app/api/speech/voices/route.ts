import { NextResponse } from "next/server";
import { edgeVoices } from "@/lib/edge-voice";

export const dynamic = "force-dynamic";

/**
 * Microsoft's Natural voices, for the reader's voice menu.
 *
 * An empty list rather than an error when the service cannot be reached: the
 * menu then simply offers the machine's own voices, as it always did.
 */
export async function GET() {
  try {
    return NextResponse.json({ voices: await edgeVoices() });
  } catch (err) {
    return NextResponse.json({ voices: [], error: (err as Error).message });
  }
}
