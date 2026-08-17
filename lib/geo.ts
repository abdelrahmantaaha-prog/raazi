/**
 * Slippy-map arithmetic: turning coordinates into the tiles that show them.
 *
 * This is the whole of the mapping stack. Google's static and embedded maps
 * both want a key and a billing account, and scraping their pages is both
 * against their terms and certain to break; OpenStreetMap serves the same
 * tiles unauthenticated, and the Web Mercator projection they are cut on is
 * fifteen lines of trigonometry. So there is no map library here — the tiles
 * are plain images positioned by these functions.
 *
 * Everything works in *projected pixels* at a given zoom rather than in
 * degrees, because that is the space where fitting a set of points to a
 * viewport is simple arithmetic instead of an inversion.
 */

export const TILE = 256;
/** OpenStreetMap's own tiles stop here, and past it the world is a carpet. */
export const MAX_ZOOM = 18;
export const MIN_ZOOM = 1;

export interface Point {
  lat: number;
  lon: number;
}

export interface View {
  zoom: number;
  /** Centre of the viewport, in projected pixels at this zoom. */
  cx: number;
  cy: number;
  width: number;
  height: number;
}

const worldSize = (zoom: number) => TILE * 2 ** zoom;

/** Longitude to projected x. Linear — Mercator only distorts latitude. */
export function projectX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * worldSize(zoom);
}

/**
 * Latitude to projected y. Clamped to the Mercator limit: the projection sends
 * the poles to infinity, and a source that says "the Arctic" should render as
 * the top of the map rather than as NaN.
 */
export function projectY(lat: number, zoom: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return y * worldSize(zoom);
}

/** A viewport of the given size centred on one coordinate. */
export function centreView(point: Point, zoom: number, width: number, height: number): View {
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom)));
  return { zoom: z, cx: projectX(point.lon, z), cy: projectY(point.lat, z), width, height };
}

/**
 * The closest view that still holds every point.
 *
 * Zooms are whole numbers because tiles only exist at whole numbers, so this
 * walks down from the tightest and takes the first that fits. A single point
 * has no extent to fit, so it falls back to the caller's preferred zoom rather
 * than zooming to the maximum on nothing.
 */
export function fitView(
  points: Point[],
  width: number,
  height: number,
  opts: { padding?: number; fallbackZoom?: number } = {}
): View | null {
  if (points.length === 0) return null;
  const padding = opts.padding ?? 36;

  if (points.length === 1) {
    return centreView(points[0], opts.fallbackZoom ?? 9, width, height);
  }

  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
    const xs = points.map((p) => projectX(p.lon, z));
    const ys = points.map((p) => projectY(p.lat, z));
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);

    if (spanX <= width - padding * 2 && spanY <= height - padding * 2) {
      return {
        zoom: z,
        cx: (Math.max(...xs) + Math.min(...xs)) / 2,
        cy: (Math.max(...ys) + Math.min(...ys)) / 2,
        width,
        height,
      };
    }
  }
  // Points on opposite sides of the planet: show the whole world.
  return { zoom: MIN_ZOOM, cx: worldSize(MIN_ZOOM) / 2, cy: worldSize(MIN_ZOOM) / 2, width, height };
}

/**
 * The same view, a step closer or further out.
 *
 * Zooming a tile map is not scaling the picture — it is asking for a different
 * set of tiles, cut at a different scale, which is why the result stays sharp
 * where a scaled image would smear. Projected coordinates double with every
 * whole zoom level, so moving the centre between levels is one multiplication.
 */
export function zoomView(view: View, delta: number): View {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom + delta));
  const factor = 2 ** (zoom - view.zoom);
  return { ...view, zoom, cx: view.cx * factor, cy: view.cy * factor };
}

export interface Tile {
  z: number;
  x: number;
  y: number;
  /** Where this tile's top-left corner sits inside the viewport. */
  left: number;
  top: number;
}

/**
 * The tiles covering a view, with their positions.
 *
 * Columns that fall off the edge of the world are dropped rather than wrapped:
 * at low zoom a wide viewport asks for tiles that do not exist, and a wrapped
 * one would draw Asia to the left of the Americas.
 */
export function tilesFor(view: View): Tile[] {
  const left = view.cx - view.width / 2;
  const top = view.cy - view.height / 2;
  const count = 2 ** view.zoom;

  const out: Tile[] = [];
  for (let x = Math.floor(left / TILE); x <= Math.floor((left + view.width - 1) / TILE); x++) {
    for (let y = Math.floor(top / TILE); y <= Math.floor((top + view.height - 1) / TILE); y++) {
      if (x < 0 || y < 0 || x >= count || y >= count) continue;
      out.push({ z: view.zoom, x, y, left: x * TILE - left, top: y * TILE - top });
    }
  }
  return out;
}

/** Where a coordinate falls inside a view, or null when it falls outside. */
export function place(view: View, point: Point): { x: number; y: number } | null {
  const x = projectX(point.lon, view.zoom) - (view.cx - view.width / 2);
  const y = projectY(point.lat, view.zoom) - (view.cy - view.height / 2);
  if (x < 0 || y < 0 || x > view.width || y > view.height) return null;
  return { x, y };
}

/**
 * How closely to frame a thing, from what Wikidata says it is.
 *
 * A country and a building both come back as a single coordinate, and drawn at
 * the same zoom one of them is useless: Egypt as a street corner, or a
 * consulate as a continent. There is no extent in the data, so the class is the
 * only signal available.
 */
const ZOOM_BY_CLASS: [string[], number][] = [
  [["Q6256", "Q3624078", "Q51576574", "Q7275", "Q1250464"], 5], // country, state, empire
  [["Q10864048", "Q35657", "Q82794", "Q1620908"], 7], // first-level division, region
  [["Q515", "Q1549591", "Q1093829", "Q200250"], 11], // city, big city, metropolis
  [["Q3957", "Q532", "Q486972"], 12], // town, village, settlement
  [["Q123705", "Q584", "Q2983893"], 14], // neighbourhood, quarter
  [["Q41176", "Q811979", "Q1497364", "Q16970", "Q44539", "Q57821"], 16], // building, structure
];

export function zoomForClasses(classes: string[]): number {
  for (const [ids, zoom] of ZOOM_BY_CLASS) {
    if (classes.some((c) => ids.includes(c))) return zoom;
  }
  return 9;
}

// ---------------------------------------------------------------------------
// Links out
// ---------------------------------------------------------------------------

const fix = (n: number) => n.toFixed(5).replace(/\.?0+$/, "");

/**
 * Google's own documented URL scheme — a link, not a scraped page, and needing
 * no key. This is the sanctioned way to hand a coordinate to Google Maps.
 */
export function googleMapsUrl(point: Point): string {
  const params = new URLSearchParams({ api: "1", query: `${fix(point.lat)},${fix(point.lon)}` });
  return `https://www.google.com/maps/search/?${params}`;
}

export function osmUrl(point: Point, zoom = 12): string {
  return `https://www.openstreetmap.org/?mlat=${fix(point.lat)}&mlon=${fix(point.lon)}#map=${zoom}/${fix(point.lat)}/${fix(point.lon)}`;
}

/** "31.7767°N, 35.2342°E" — how a coordinate should read to a person. */
export function formatCoords(point: Point): string {
  const ns = point.lat >= 0 ? "N" : "S";
  const ew = point.lon >= 0 ? "E" : "W";
  return `${Math.abs(point.lat).toFixed(4)}°${ns}, ${Math.abs(point.lon).toFixed(4)}°${ew}`;
}
