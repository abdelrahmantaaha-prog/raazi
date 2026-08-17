/**
 * Slippy-map arithmetic.
 *
 * A map that is wrong by a few pixels looks exactly like a map that is right,
 * which is why this is tested against known coordinates rather than eyeballed.
 * The reference values are the ones every tile server agrees on.
 *
 *   npx tsx scripts/test-geo.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

const {
  TILE, MAX_ZOOM, MIN_ZOOM,
  projectX, projectY, centreView, fitView, tilesFor, place, zoomView,
  zoomForClasses, googleMapsUrl, osmUrl, formatCoords,
} = await import("../lib/geo.ts");

// ---------------------------------------------------------------------------
section("Zooming asks for different tiles without losing the spot");
// ---------------------------------------------------------------------------
{
  const jerusalem = { lat: 31.7767, lon: 35.2342 };
  const start = centreView(jerusalem, 10, 640, 260);

  for (const step of [1, 2, -1, -3]) {
    const after = zoomView(start, step);
    const at = place(after, jerusalem);
    check(
      `${step > 0 ? "in" : "out"} ${Math.abs(step)} keeps the place dead centre`,
      at !== null && near(at.x, 320) && near(at.y, 130),
      at ? `${at.x.toFixed(1)},${at.y.toFixed(1)}` : "off the map"
    );
    check(`and lands on zoom ${start.zoom + step}`, after.zoom === start.zoom + step);
  }

  check("it stops at the closest tiles that exist", zoomView(start, 99).zoom === MAX_ZOOM);
  check("and at the furthest", zoomView(start, -99).zoom === MIN_ZOOM);
  check(
    "a closer view asks for different tiles",
    tilesFor(zoomView(start, 2))[0].z === 12 && tilesFor(start)[0].z === 10
  );
  check("the viewport itself does not change size",
    zoomView(start, 3).width === start.width && zoomView(start, 3).height === start.height);
}

// ---------------------------------------------------------------------------
section("The projection agrees with every other tile server");
// ---------------------------------------------------------------------------
check("null island is the centre of the world", near(projectX(0, 0), 128) && near(projectY(0, 0), 128));
check("the dateline is the right edge", near(projectX(180, 0), 256));
check("the antimeridian is the left edge", near(projectX(-180, 0), 0));
check("longitude is linear", near(projectX(90, 1), 384));
// Jerusalem, 31.7767N 35.2342E, is tile 12/2448/1666 on any slippy map.
check(
  "Jerusalem lands in the tile everyone else puts it in",
  Math.floor(projectX(35.2342, 12) / TILE) === 2448 &&
    Math.floor(projectY(31.7767, 12) / TILE) === 1666,
  `${Math.floor(projectX(35.2342, 12) / TILE)}/${Math.floor(projectY(31.7767, 12) / TILE)}`
);
// The same numbers again from the published formula, written out differently.
// A shared helper could be wrong in both places; this cannot be.
check(
  "and agrees with the standard formula computed independently",
  (() => {
    const lat = 31.7767, lon = 35.2342, n = 2 ** 12;
    const rad = (lat * Math.PI) / 180;
    const x = Math.floor(((lon + 180) / 360) * n);
    const y = Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n);
    return x === Math.floor(projectX(lon, 12) / TILE) && y === Math.floor(projectY(lat, 12) / TILE);
  })()
);
check("latitude is not linear", !near(projectY(45, 0), 64, 2));
check("the north pole clamps rather than diverging", Number.isFinite(projectY(90, 4)));
check("and so does the south", Number.isFinite(projectY(-90, 4)));
check("a doubling of zoom doubles the world", near(projectX(35, 5) * 2, projectX(35, 6)));

// ---------------------------------------------------------------------------
section("A centred view puts its point in the middle");
// ---------------------------------------------------------------------------
{
  const jerusalem = { lat: 31.7767, lon: 35.2342 };
  const v = centreView(jerusalem, 12, 640, 260);
  const at = place(v, jerusalem);
  check("dead centre", near(at.x, 320) && near(at.y, 130), `${at?.x},${at?.y}`);
  check("the zoom is honoured", v.zoom === 12);
  check("zoom is clamped to what tiles exist for", centreView(jerusalem, 99, 100, 100).zoom === MAX_ZOOM);
  check("and to the bottom", centreView(jerusalem, -5, 100, 100).zoom === MIN_ZOOM);
}

// ---------------------------------------------------------------------------
section("Tiles cover the view and no more");
// ---------------------------------------------------------------------------
{
  const v = centreView({ lat: 31.7767, lon: 35.2342 }, 12, 640, 260);
  const tiles = tilesFor(v);
  check("enough tiles to cover it", tiles.length >= Math.ceil(640 / TILE) * Math.ceil(260 / TILE));
  check("not absurdly many", tiles.length <= 4 * 3);
  check("all at the view's zoom", tiles.every((t) => t.z === 12));
  check(
    "every tile overlaps the viewport",
    tiles.every((t) => t.left < 640 && t.top < 260 && t.left + TILE > 0 && t.top + TILE > 0)
  );
  check(
    "they tile without gaps",
    tiles.every((t) => (t.left % TILE + TILE) % TILE === (tiles[0].left % TILE + TILE) % TILE)
  );

  // A view wider than the world at low zoom asks for columns that do not exist.
  const wide = centreView({ lat: 0, lon: 0 }, 1, 2000, 400);
  const count = 2 ** 1;
  check(
    "tiles off the edge of the world are dropped, not wrapped",
    tilesFor(wide).every((t) => t.x >= 0 && t.x < count && t.y >= 0 && t.y < count)
  );
}

// ---------------------------------------------------------------------------
section("Fitting a set of places");
// ---------------------------------------------------------------------------
{
  const places = [
    { lat: 31.7767, lon: 35.2342 },  // Jerusalem
    { lat: 24.65, lon: 46.71 },      // Riyadh
    { lat: 30.0444, lon: 31.2357 },  // Cairo
  ];
  const v = fitView(places, 960, 420);
  check("all three land inside the frame", places.every((p) => place(v, p) !== null));
  check("with room to spare for their pins",
    places.every((p) => {
      const at = place(v, p);
      return at.x > 8 && at.y > 8 && at.x < 952 && at.y < 412;
    }));
  check("and it is not zoomed out further than it needs to be",
    fitView(places, 960, 420).zoom >= 4, `${v.zoom}`);
  check("one zoom tighter would not fit",
    (() => {
      const xs = places.map((p) => projectX(p.lon, v.zoom + 1));
      const ys = places.map((p) => projectY(p.lat, v.zoom + 1));
      return Math.max(...xs) - Math.min(...xs) > 960 - 72 ||
             Math.max(...ys) - Math.min(...ys) > 420 - 72;
    })());

  check("a single place falls back rather than zooming to the rooftop",
    fitView([places[0]], 640, 260, { fallbackZoom: 9 }).zoom === 9);
  check("no places, no view", fitView([], 640, 260) === null);
  check("opposite sides of the planet still render",
    fitView([{ lat: 60, lon: -170 }, { lat: -60, lon: 170 }], 400, 200).zoom === MIN_ZOOM);
}

// ---------------------------------------------------------------------------
section("A point outside the frame is not drawn on its edge");
// ---------------------------------------------------------------------------
{
  const v = centreView({ lat: 31.7767, lon: 35.2342 }, 12, 640, 260);
  check("somewhere far away is refused", place(v, { lat: -33.86, lon: 151.2 }) === null);
  check("somewhere near is placed", place(v, { lat: 31.79, lon: 35.24 }) !== null);
}

// ---------------------------------------------------------------------------
section("How closely to frame a thing");
// ---------------------------------------------------------------------------
check("a country gets the whole country", zoomForClasses(["Q6256"]) === 5);
check("a city gets the city", zoomForClasses(["Q515"]) === 11);
check("a building gets the street", zoomForClasses(["Q41176"]) === 16);
check("something unclassified gets a sensible middle", zoomForClasses(["Q999999"]) === 9);
check("the most specific class wins", zoomForClasses(["Q6256", "Q515"]) === 5);

// ---------------------------------------------------------------------------
section("Links out are links, not scrapes");
// ---------------------------------------------------------------------------
{
  const p = { lat: 31.7767, lon: 35.2342 };
  const g = googleMapsUrl(p);
  check("Google gets its own documented search URL", g.startsWith("https://www.google.com/maps/search/?"));
  check("with the coordinate as the query", g.includes("query=31.7767%2C35.2342"), g);
  check("and no API key is involved", !/key=/.test(g));
  check("OpenStreetMap gets a marker and a zoom",
    osmUrl(p, 12) === "https://www.openstreetmap.org/?mlat=31.7767&mlon=35.2342#map=12/31.7767/35.2342",
    osmUrl(p, 12));
  check("coordinates read as coordinates", formatCoords(p) === "31.7767°N, 35.2342°E");
  check("and the southern hemisphere is not silently northern",
    formatCoords({ lat: -33.8688, lon: 151.2093 }) === "33.8688°S, 151.2093°E");
  check("nor the western eastern",
    formatCoords({ lat: 38.895, lon: -77.0367 }) === "38.8950°N, 77.0367°W");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
