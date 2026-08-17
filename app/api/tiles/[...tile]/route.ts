import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { DATA_DIR } from "@/lib/db";
import { MAX_ZOOM } from "@/lib/geo";

export const dynamic = "force-dynamic";

const TILES_DIR = path.join(DATA_DIR, "tiles");
const UA = "Corpus/0.1 (personal research tool; single-user, local)";

/**
 * Map tiles, fetched once from OpenStreetMap and then served from disk.
 *
 * Proxied rather than linked straight from the page for two reasons. It lets
 * every request carry one identifiable user agent, which is what OpenStreetMap
 * asks of anything that is not a browser; and it means a library that has been
 * looked at once keeps its maps with no connection, like the covers and the
 * portraits before it.
 *
 * Tiles are immutable for our purposes — a road moving is not something this
 * app needs to notice — so a stored one is never re-fetched.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ tile: string[] }> }) {
  const parts = (await ctx.params).tile ?? [];
  if (parts.length !== 3) return new NextResponse(null, { status: 400 });

  const [z, x, y] = parts.map((p) => Number(p.replace(/\.png$/, "")));
  const count = 2 ** z;
  // Bounds-checked because these numbers arrive from a URL: without this the
  // path below could be talked into leaving the tiles directory.
  if (
    !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) ||
    z < 0 || z > MAX_ZOOM || x < 0 || y < 0 || x >= count || y >= count
  ) {
    return new NextResponse(null, { status: 400 });
  }

  const file = path.join(TILES_DIR, String(z), String(x), `${y}.png`);

  if (!fs.existsSync(file)) {
    try {
      const res = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
        headers: { "user-agent": UA },
      });
      if (!res.ok) return new NextResponse(null, { status: 502 });
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, buf);
    } catch {
      return new NextResponse(null, { status: 502 });
    }
  }

  const bytes = await fs.promises.readFile(file);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=604800, immutable",
    },
  });
}
