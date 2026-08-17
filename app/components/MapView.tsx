"use client";

import { useEffect, useState } from "react";
import {
  TILE,
  centreView,
  fitView,
  formatCoords,
  googleMapsUrl,
  osmUrl,
  place,
  tilesFor,
  zoomView,
  MIN_ZOOM,
  MAX_ZOOM,
  type Point,
  type View,
} from "@/lib/geo";

export interface Marker extends Point {
  id: number;
  name: string;
  type: string;
}

/**
 * A map, made of plain images.
 *
 * No mapping library and no key: the tiles are images positioned by the
 * arithmetic in lib/geo, which is all a slippy map actually is. Zooming asks
 * for a different set of tiles rather than scaling the ones it has, so it stays
 * sharp at every level — and the links underneath still hand the coordinate to
 * a full map when you want to pan around properly.
 *
 * Drawn as SVG rather than positioned HTML so that it scales as one piece: on a
 * narrow screen a stack of absolutely-positioned tiles either crops or drifts
 * out of register with its pins, whereas a viewBox simply shrinks.
 */
export function MapView({
  markers,
  centre,
  zoom,
  width = 640,
  height = 260,
  label,
  centrePin = false,
}: {
  markers: Marker[];
  /** A single point to frame; otherwise the view is fitted to the markers. */
  centre?: Point;
  zoom?: number;
  width?: number;
  height?: number;
  label?: string;
  /** Draws a fixed marker on the centre, for a map that is about one place. */
  centrePin?: boolean;
}) {
  const initial: View | null = centre
    ? centreView(centre, zoom ?? 9, width, height)
    : fitView(markers, width, height, { fallbackZoom: zoom ?? 9 });

  const [view, setView] = useState<View | null>(initial);
  // The starting frame is computed from props, so a filter that changes the
  // markers has to reset it — otherwise the map stays where the previous set
  // of places put it.
  useEffect(() => {
    setView(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers.length, centre?.lat, centre?.lon, zoom, width, height]);

  if (!view) return null;

  const tiles = tilesFor(view);
  const pins = markers
    .map((m) => ({ marker: m, at: place(view, m) }))
    .filter((p): p is { marker: Marker; at: { x: number; y: number } } => p.at !== null);

  return (
    <div className="relative overflow-hidden rounded-lg border border-[var(--color-rule)] bg-[var(--color-accent-soft)]">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto w-full"
        role="img"
        aria-label={label ?? `Map of ${markers.length} place(s)`}
      >
        {tiles.map((t) => (
          <image
            key={`${t.z}/${t.x}/${t.y}`}
            href={`/api/tiles/${t.z}/${t.x}/${t.y}`}
            x={t.left}
            y={t.top}
            width={TILE}
            height={TILE}
          />
        ))}

        {centre && centrePin && <Pin x={width / 2} y={height / 2} />}

        {pins.map(({ marker, at }) => (
          // SVG's own anchor, not next/link: an HTML <a> is not valid here.
          <a key={marker.id} href={`/pedia/${marker.id}`} className="group">
            <title>{marker.name}</title>
            {/* A generous invisible target — the visible dot is 5px across. */}
            <circle cx={at.x} cy={at.y} r={11} fill="transparent" className="cursor-pointer" />
            <Pin x={at.x} y={at.y} />
            {/* The name on hover. A native SVG <title> works but waits a second
                for the browser to decide you meant it, which is too slow for
                reading a map of a dozen places. */}
            <text
              x={at.x}
              y={at.y - 11}
              textAnchor="middle"
              fontSize={12}
              fontWeight={600}
              fill="var(--color-ink)"
              className="pointer-events-none opacity-0 transition-opacity group-hover:opacity-100"
              style={{ paintOrder: "stroke", stroke: "white", strokeWidth: 4 }}
            >
              {marker.name.length > 28 ? `${marker.name.slice(0, 27)}…` : marker.name}
            </text>
          </a>
        ))}
      </svg>

      <div className="absolute left-2 top-2 flex flex-col overflow-hidden rounded border border-black/15 bg-white/90 shadow-sm">
        {([1, -1] as const).map((step) => (
          <button
            key={step}
            onClick={() => setView((v) => (v ? zoomView(v, step) : v))}
            disabled={step > 0 ? view.zoom >= MAX_ZOOM : view.zoom <= MIN_ZOOM}
            title={step > 0 ? "Closer" : "Further out"}
            aria-label={step > 0 ? "Zoom in" : "Zoom out"}
            className="h-7 w-7 text-base leading-none text-[var(--color-ink)] transition hover:bg-[var(--color-accent-soft)] disabled:opacity-30"
          >
            {step > 0 ? "+" : "−"}
          </button>
        ))}
        <button
          onClick={() => setView(initial)}
          title="Back to the starting view"
          aria-label="Reset the map"
          className="h-7 w-7 border-t border-black/10 text-[0.65rem] leading-none text-[var(--color-muted)] transition hover:bg-[var(--color-accent-soft)]"
        >
          ⌂
        </button>
      </div>

      <span className="absolute bottom-0 right-0 bg-white/80 px-1.5 py-0.5 text-[0.6rem] text-[var(--color-muted)]">
        z{view.zoom} · ©{" "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          OpenStreetMap
        </a>{" "}
        contributors
      </span>
    </div>
  );
}

function Pin({ x, y }: { x: number; y: number }) {
  return (
    <>
      <circle cx={x} cy={y} r={5.5} fill="white" opacity={0.9} />
      <circle cx={x} cy={y} r={4} fill="var(--color-accent)" />
    </>
  );
}

/**
 * The "where is this" card on a place's own entry: the map, the coordinate as
 * a number, and the two links out.
 *
 * The coordinate is Wikidata's, and is labelled as such. For somewhere like
 * Judea and Samaria a centroid is not a neutral fact, and this app's whole
 * habit is to say where a claim came from rather than to assert it.
 */
export function WhereCard({
  name,
  lat,
  lon,
  zoom,
  wikidata,
}: {
  name: string;
  lat: number;
  lon: number;
  zoom?: number;
  wikidata?: string;
}) {
  const point = { lat, lon };
  return (
    <section className="rounded-lg border border-[var(--color-rule)] bg-white p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-serif text-lg font-semibold">Where</h2>
        <span className="font-mono text-xs text-[var(--color-muted)]">{formatCoords(point)}</span>
        <span className="text-xs text-[var(--color-muted)]">
          as given by{" "}
          {wikidata ? (
            <a
              href={`https://www.wikidata.org/wiki/${wikidata}`}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Wikidata
            </a>
          ) : (
            "Wikidata"
          )}
        </span>
      </div>

      <div className="mt-3">
        <MapView
          markers={[]}
          centre={point}
          zoom={zoom}
          height={220}
          centrePin
          label={`Map of ${name}`}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        <a
          href={googleMapsUrl(point)}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-[var(--color-rule)] px-2.5 py-1 font-medium hover:bg-[var(--color-accent-soft)]"
        >
          Open in Google Maps
        </a>
        <a
          href={osmUrl(point, zoom ?? 9)}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-[var(--color-rule)] px-2.5 py-1 font-medium hover:bg-[var(--color-accent-soft)]"
        >
          Open in OpenStreetMap
        </a>
      </div>
    </section>
  );
}
