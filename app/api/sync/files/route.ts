import { NextResponse } from "next/server";
import { listFiles } from "@/lib/sync";

export const dynamic = "force-dynamic";

/** Every source file, cover and portrait, with sizes, for a peer to compare — of the open discipline, or the one named. */
export async function GET(req: Request) {
  const discipline = new URL(req.url).searchParams.get("discipline");
  return NextResponse.json({ files: listFiles(discipline) }, { headers: { "cache-control": "no-store" } });
}
