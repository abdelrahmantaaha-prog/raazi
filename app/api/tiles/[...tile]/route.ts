import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { DATA_DIR } from "@/lib/db";
import { MAX_ZOOM } from "@/lib/geo";

export const dynamic = "force-dynamic";

const TILES_DIR = path.join(DATA_DIR, "tiles");
const UA = "Raazi/0.1 (personal research tool; single-user, local)";

/**
 * How deep the map may be stored, and how much of it.
 *
 * The map itself never asks past zoom 16 — beyond that is house numbers, and
 * this is a map of where things happened, not a street directory. The route
 * used to accept anything up to MAX_ZOOM, and each further level is four times
 * the tiles: a script walking zoom 18 could quietly write a few hundred
 * thousand files. The file ceiling is the second half of the same guard, for
 * the case of a wide sweep at a legal zoom; past it, stored tiles are still
 * served and new ones are simply not fetched.
 */
const MAX_STORED_ZOOM = Math.min(16, MAX_ZOOM);
const MAX_TILES = 20000;

/** Counted once and then kept in step, because counting a directory tree per
 *  tile request would cost more than the fetch it is guarding. */
let stored: number | null = null;

function countStored(): number {
  let n = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.name.endsWith(".png")) n++;
    }
  };
  walk(TILES_DIR);
  return n;
}

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
    z < 0 || z > MAX_STORED_ZOOM || x < 0 || y < 0 || x >= count || y >= count
  ) {
    return new NextResponse(null, { status: 400 });
  }

  const file = path.join(TILES_DIR, String(z), String(x), `${y}.png`);

  if (!fs.existsSync(file)) {
    if (stored === null) stored = countStored();
    if (stored >= MAX_TILES) {
      // Not an error the map can do anything about: it draws a blank square
      // and the rest of the page is unaffected.
      return new NextResponse(null, { status: 404 });
    }
    try {
      const res = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
        headers: { "user-agent": UA },
      });
      if (!res.ok) return new NextResponse(null, { status: 502 });
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, buf);
      stored++;
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
