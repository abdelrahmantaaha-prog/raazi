"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NATURES } from "@/lib/relations";
import { focusLayout } from "@/lib/focus";
import type { NetEdge, NetNode, Network, Star } from "@/lib/network";

/** How long the map takes to rearrange itself around a selection. */
const TWEEN_MS = 620;

/**
 * Ease-out cubic.
 *
 * Motion that starts fast and settles is what makes a rearrangement readable:
 * you see where things are going immediately, and the ending is calm enough to
 * read. A linear tween of two hundred nodes reads as a machine resetting.
 */
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * The library as a map you can move around in.
 *
 * Drawn on a dark field rather than on paper, which is the one place in Raazi
 * that departs from the rest: against white, two hundred faint edges in ten
 * muted colours turn to grey mush, and the coloured ties are the whole reason
 * the picture is worth drawing. The chrome around it stays paper, so this reads
 * as a framed plate rather than as a different program.
 *
 * The layout is computed on the server and fixed. What happens here is
 * selecting, and zooming.
 */
export function NetworkMap({
  nodes,
  edges,
  stars,
  width,
  height,
}: {
  nodes: NetNode[];
  edges: NetEdge[];
  stars: Star[];
  width: number;
  height: number;
}) {
  /**
   * Selection is by click, not by hover.
   *
   * On a map this dense, hovering meant the highlight flickered through every
   * node the pointer crossed on its way somewhere. A click holds still while
   * you read it — and a second click on the same node opens the entry, so
   * inspecting and navigating are the same gesture done once or twice.
   */
  const [selected, setSelected] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);

  /**
   * Where every node is *right now*, which is not where the layout put it.
   *
   * Selecting an entity gathers its connections around it, and that gathering
   * has to be watchable — a graph that teleports into a new arrangement tells
   * you nothing about which node went where, and the whole value of the move is
   * that you can follow your subject's neighbours in from wherever they were.
   *
   * Positions are tweened in state rather than by CSS transition because the
   * edges have to travel with the nodes: a line's endpoints are geometry
   * attributes, and those do not transition in every browser. One rAF loop
   * moving one source of truth keeps nodes and their ties rigidly together.
   */
  const [pos, setPos] = useState<Map<number, { x: number; y: number }>>(
    () => new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]))
  );
  const frame = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  /**
   * Where each gathered neighbour's name should sit relative to its dot.
   *
   * Decided by the layout, which is the only thing that knows the ring a node
   * landed on — and the ring is what the answer turns on, since two rings level
   * with each other would otherwise write into the same horizontal band. Empty
   * when nothing is selected, where the ordinary rule (below the dot) applies.
   */
  const [hints, setHints] = useState<Map<number, { above?: boolean; labelShift?: number }>>(
    () => new Map()
  );

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const at = useCallback(
    (id: number) => pos.get(id) ?? byId.get(id) ?? { x: 0, y: 0 },
    [pos, byId]
  );

  /** Every tie each entity has, so a selection can name them without a request. */
  const ties = useMemo(() => {
    const map = new Map<number, { other: NetNode; edge: NetEdge }[]>();
    for (const e of edges) {
      const a = byId.get(e.a);
      const b = byId.get(e.b);
      if (!a || !b) continue;
      if (!map.has(e.a)) map.set(e.a, []);
      if (!map.has(e.b)) map.set(e.b, []);
      map.get(e.a)!.push({ other: b, edge: e });
      map.get(e.b)!.push({ other: a, edge: e });
    }
    return map;
  }, [edges, byId]);

  /**
   * Which names are written on the map at rest.
   *
   * Most connected first, and only where the text clears every name already
   * placed. Labelling a fixed top-forty regardless of where they landed put
   * overlapping text over the crowded clusters and left the sparse ones bare.
   */
  const labelled = useMemo(() => {
    const chosen = new Set<number>();
    const boxes: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const n of [...nodes].sort((a, b) => b.degree - a.degree)) {
      // Per-character width is an estimate — real glyphs vary, and Arabic and
      // capitals run wider than the average — so it is deliberately generous
      // and the box is padded. Under-estimating shows up as touching text.
      const half = (clip(n.name).length * 7.6) / 2 + 4;
      const box = { x1: n.x - half, y1: n.y + n.r, x2: n.x + half, y2: n.y + n.r + 21 };
      if (boxes.some((b) => box.x1 < b.x2 && b.x1 < box.x2 && box.y1 < b.y2 && b.y1 < box.y2)) {
        continue;
      }
      boxes.push(box);
      chosen.add(n.id);
    }
    return chosen;
  }, [nodes]);

  const active = selected === null ? null : byId.get(selected) ?? null;
  const near = useMemo(() => {
    if (selected === null) return new Set<number>();
    return new Set((ties.get(selected) ?? []).map((t) => t.other.id));
  }, [selected, ties]);

  const lit = (id: number) => selected === null || id === selected || near.has(id);

  /**
   * Draw order: faded first, lit last, the subject last of all.
   *
   * SVG has no z-index — later elements paint over earlier ones, and they take
   * the clicks too. Each node carries an invisible target a good deal wider
   * than its dot so it is easy to hit, and those targets overlap; a faded node
   * drawn after a lit one would sit on top of it and swallow the click. Which
   * is exactly what happened: clicking a connection gathered in the foreground
   * opened whatever unrelated entity happened to be behind it.
   */
  const painted = useMemo(() => {
    if (selected === null) return nodes;
    return [...nodes].sort((a, b) => rank(a) - rank(b));

    function rank(n: NetNode): number {
      if (n.id === selected) return 2;
      return near.has(n.id) ? 1 : 0;
    }
  }, [nodes, selected, near]);

  /**
   * Moves every node to where the current selection says it belongs.
   *
   * Targets come from `focusLayout`, which centres the subject on the middle of
   * what you are *already looking at* rather than the middle of the canvas —
   * the canvas is several screens wide, and gathering a cluster somewhere off
   * to the left would defeat the point. Deselecting sends everything home to
   * the positions the server computed.
   */
  useEffect(() => {
    const el = scroller.current;
    const network: Network = { nodes, edges, width, height, omitted: 0, total: nodes.length };

    let targets: Map<number, { x: number; y: number }>;
    if (selected === null) {
      targets = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
      setHints(new Map());
    } else {
      // The visible rectangle, in canvas units — the SVG is scaled by `zoom`,
      // so screen pixels have to be divided back out before they mean anything
      // to a layout that thinks in canvas coordinates.
      const view = el
        ? {
            width: el.clientWidth / zoom,
            height: el.clientHeight / zoom,
            cx: (el.scrollLeft + el.clientWidth / 2) / zoom,
            cy: (el.scrollTop + el.clientHeight / 2) / zoom,
          }
        : { width, height, cx: width / 2, cy: height / 2 };

      const focus = focusLayout(network, selected, view);
      setHints(
        new Map(
          [...focus.entries()].map(([id, p]) => [id, { above: p.above, labelShift: p.labelShift }])
        )
      );
      // Anything untouched by the selection stays exactly where it is and fades
      // out instead. Moving a hundred irrelevant nodes would be slower and would
      // read as chaos rather than as an answer.
      targets = new Map(nodes.map((n) => [n.id, focus.get(n.id) ?? at(n.id)]));
    }

    const from = new Map(nodes.map((n) => [n.id, at(n.id)]));
    const started = performance.now();

    // Respect a stated preference for less motion: jump, don't animate.
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (still) {
      setPos(targets);
      return;
    }

    const step = (now: number) => {
      const t = ease(Math.min(1, (now - started) / TWEEN_MS));
      const next = new Map<number, { x: number; y: number }>();
      for (const n of nodes) {
        const a = from.get(n.id)!;
        const b = targets.get(n.id)!;
        next.set(n.id, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
      setPos(next);
      if (t < 1) frame.current = requestAnimationFrame(step);
    };

    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
    // `at` and `pos` are deliberately excluded: this reads the positions once,
    // at the moment the selection changes, and animating from them would
    // otherwise restart the tween on every frame it produced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, nodes, edges, width, height, zoom]);

  /**
   * First click selects, second opens.
   *
   * Each node is a real link, and the first click cancels it rather than the
   * second one synthesising a navigation: that way the address is in the status
   * bar, middle-click and ctrl-click open a tab the way they should, and
   * keyboard activation needs no special case.
   */
  const choose = (id: number, e: { preventDefault: () => void }) => {
    if (selected === id) return; // Let the link do its job.
    e.preventDefault();
    setSelected(id);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex overflow-hidden rounded border border-[var(--color-rule)]">
          {([0.25, -0.25] as const).map((step) => (
            <button
              key={step}
              onClick={() => setZoom((z) => Math.round(Math.min(3, Math.max(0.4, z + step)) * 100) / 100)}
              disabled={step > 0 ? zoom >= 3 : zoom <= 0.4}
              aria-label={step > 0 ? "Zoom in" : "Zoom out"}
              className="w-8 bg-white py-1 text-base leading-none transition hover:bg-[var(--color-accent-soft)] disabled:opacity-30"
            >
              {step > 0 ? "+" : "−"}
            </button>
          ))}
          <button
            onClick={() => setZoom(1)}
            className="border-l border-[var(--color-rule)] bg-white px-2 py-1 text-xs tabular-nums transition hover:bg-[var(--color-accent-soft)]"
            title="Back to actual size"
          >
            {Math.round(zoom * 100)}%
          </button>
        </span>

        {active && (
          <button
            onClick={() => setSelected(null)}
            className="rounded-full border border-[var(--color-rule)] bg-white px-3 py-1 text-xs transition hover:bg-[var(--color-accent-soft)]"
          >
            Clear selection
          </button>
        )}

        {/* What the line patterns mean. Colour alone is not enough at one pixel
            wide on a dark field, and telling an ally from an enemy is the whole
            point of colouring them in the first place. */}
        <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          {Object.values(NATURES).map((spec) => (
            <span key={spec.id} className="flex items-center gap-1" title={spec.note}>
              <svg width={22} height={8} aria-hidden>
                <line
                  x1={0}
                  y1={4}
                  x2={22}
                  y2={4}
                  stroke={spec.colour}
                  strokeWidth={2}
                  strokeDasharray={spec.dash}
                />
              </svg>
              <span className="text-[0.68rem] text-[var(--color-muted)]">{spec.label}</span>
            </span>
          ))}
        </span>
      </div>

      <div
        ref={scroller}
        className="overflow-auto rounded-lg border border-[var(--color-rule)]"
        style={{ maxHeight: "78vh", background: "#0f1016" }}
      >
        <svg
          width={Math.round(width * zoom)}
          height={Math.round(height * zoom)}
          viewBox={`0 0 ${width} ${height}`}
          className="block max-w-none"
          role="img"
          aria-label={`${nodes.length} connected entities`}
        >
          <defs>
            <radialGradient id="net-sky" cx="50%" cy="45%" r="75%">
              <stop offset="0%" stopColor="#1c1f2b" />
              <stop offset="55%" stopColor="#14161e" />
              <stop offset="100%" stopColor="#0c0d12" />
            </radialGradient>
            {/* The clip travels with its portrait. Left at the layout position
                it would cut the face off the moment anything moved. */}
            {nodes
              .filter((n) => n.hasPortrait)
              .map((n) => {
                const p = at(n.id);
                return (
                  <clipPath key={n.id} id={`net-clip-${n.id}`}>
                    <circle cx={p.x} cy={p.y} r={n.r} />
                  </clipPath>
                );
              })}
          </defs>

          {/* Clicking the empty sky drops the selection. */}
          <rect
            width={width}
            height={height}
            fill="url(#net-sky)"
            onClick={() => setSelected(null)}
          />
          <g fill="#ffffff" pointerEvents="none">
            {stars.map((s, i) => (
              <circle key={i} cx={s.x} cy={s.y} r={s.r} opacity={s.o} />
            ))}
          </g>

          <g fill="none" strokeLinecap="round" pointerEvents="none">
            {edges.map((e, i) => {
              const a = byId.get(e.a);
              const b = byId.get(e.b);
              if (!a || !b) return null;
              const pa = at(e.a);
              const pb = at(e.b);
              const on = selected !== null && (e.a === selected || e.b === selected);
              return (
                <line
                  key={i}
                  x1={pa.x}
                  y1={pa.y}
                  x2={pb.x}
                  y2={pb.y}
                  stroke={e.colour}
                  strokeWidth={on ? 2.6 : 1.2}
                  strokeDasharray={e.dash}
                  opacity={selected === null ? 0.5 : on ? 1 : 0.03}
                  style={{ transition: "opacity 520ms ease, stroke-width 300ms ease" }}
                />
              );
            })}
          </g>

          {painted.map((n) => {
            const dim = !lit(n.id);
            const chosen = n.id === selected;
            const p = at(n.id);
            const showName = labelled.has(n.id) || chosen || near.has(n.id);
            return (
              <a
                key={n.id}
                href={`/pedia/${n.id}`}
                onClick={(e) => choose(n.id, e)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") choose(n.id, e);
                }}
                aria-label={`${n.name}, ${n.degree} connections`}
                className="cursor-pointer"
              >
                {/* Dimming lives on a group inside the link: an SVG anchor is
                    typed as an HTML one, which has no opacity attribute.
                    The fade is a CSS transition rather than part of the tween —
                    opacity does transition reliably, and letting the unrelated
                    nodes recede on their own timing while the neighbours travel
                    reads better than doing both to the same clock. */}
                <g
                  opacity={dim ? 0.07 : 1}
                  // A node faded to seven per cent is not something you were
                  // aiming at. Refusing its clicks means a near miss falls
                  // through to the sky and clears the selection, rather than
                  // opening an entity you cannot even see.
                  pointerEvents={dim ? "none" : undefined}
                  style={{ transition: "opacity 520ms ease" }}
                >
                <title>
                  {chosen
                    ? `${n.name} — click again to open`
                    : `${n.name} — ${n.degree} connection${n.degree === 1 ? "" : "s"}`}
                </title>
                {/* Easier to hit than the disc itself, which can be six pixels. */}
                <circle cx={p.x} cy={p.y} r={Math.max(n.r + 7, 14)} fill="transparent" />

                {chosen && (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={n.r + 6}
                    fill="none"
                    stroke="#f5f2ec"
                    strokeWidth={1.5}
                    opacity={0.7}
                  />
                )}

                {n.hasPortrait ? (
                  <>
                    <image
                      href={`/api/entities/${n.id}/portrait`}
                      x={p.x - n.r}
                      y={p.y - n.r}
                      width={n.r * 2}
                      height={n.r * 2}
                      clipPath={`url(#net-clip-${n.id})`}
                      preserveAspectRatio="xMidYMid slice"
                    />
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={n.r}
                      fill="none"
                      stroke={chosen ? "#f5f2ec" : "#c9a97f"}
                      strokeWidth={chosen ? 3 : 1.6}
                    />
                  </>
                ) : (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={n.r}
                    fill={chosen ? "#f5f2ec" : "#232633"}
                    stroke={chosen ? "#f5f2ec" : "#7d8698"}
                    strokeWidth={1.6}
                  />
                )}

                {showName && (
                  <text
                    x={p.x}
                    y={labelY(p.y, n.r, hints.get(n.id))}
                    textAnchor="middle"
                    fontSize={12}
                    fontWeight={chosen ? 700 : 400}
                    fill={chosen ? "#ffffff" : "#d8d5cd"}
                    style={{ paintOrder: "stroke", stroke: "#0f1016", strokeWidth: 4 }}
                    pointerEvents="none"
                  >
                    {clip(n.name)}
                  </text>
                )}
                </g>
              </a>
            );
          })}
        </svg>
      </div>

      <div className="min-h-[6rem] rounded-lg border border-[var(--color-rule)] bg-white p-3 text-sm">
        {active ? (
          <>
            <p className="font-medium">
              {active.name}{" "}
              <span className="font-normal text-[var(--color-muted)]">
                · {active.degree} connection{active.degree === 1 ? "" : "s"} · {active.mentions}{" "}
                quote{active.mentions === 1 ? "" : "s"} · click it again to open the entry
              </span>
            </p>
            <ul key={active.id} className="cascade mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[var(--color-muted)]">
              {(ties.get(active.id) ?? []).slice(0, 16).map((t, i) => (
                <li key={i} className="flex items-baseline gap-1.5">
                  <svg width={16} height={8} aria-hidden className="shrink-0">
                    <line
                      x1={0}
                      y1={4}
                      x2={16}
                      y2={4}
                      stroke={t.edge.colour}
                      strokeWidth={2}
                      strokeDasharray={t.edge.dash}
                    />
                  </svg>
                  <span className="italic">{t.edge.type}</span>
                  <button
                    onClick={() => setSelected(t.other.id)}
                    className="text-[var(--color-ink)] hover:text-[var(--color-accent)]"
                  >
                    {t.other.name}
                  </button>
                </li>
              ))}
              {(ties.get(active.id) ?? []).length > 16 && (
                <li>and {(ties.get(active.id) ?? []).length - 16} more…</li>
              )}
            </ul>
          </>
        ) : (
          <p className="text-[var(--color-muted)]">
            Click anything to see what it is tied to and how; its neighbours light up with it.
            Click it a second time to open the entry. Scroll the map to move around it, and use the
            zoom above to take in more or less of it at once.
          </p>
        )}
      </div>
    </div>
  );
}

const clip = (name: string) => (name.length > 26 ? `${name.slice(0, 25)}…` : name);

/**
 * Where a node's name goes.
 *
 * Below the dot ordinarily. Inside a gathered cluster the layout says otherwise
 * — outward from the subject, and a line further out on each successive ring —
 * because that is the only arrangement in which two rings level with each other
 * do not write their names across one another.
 */
function labelY(
  y: number,
  r: number,
  hint?: { above?: boolean; labelShift?: number }
): number {
  const shift = hint?.labelShift ?? 0;
  return hint?.above ? y - r - 7 - shift : y + r + 14 + shift;
}
