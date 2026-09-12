import { NextResponse } from "next/server";
import { listFiles } from "@/lib/sync";

export const dynamic = "force-dynamic";

/** Every source file, cover and portrait, with sizes, for a peer to compare. */
export async function GET() {
  return NextResponse.json({ files: listFiles() }, { headers: { "cache-control": "no-store" } });
}
