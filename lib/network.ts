import { db } from "./db";
import { natureOf, type Nature } from "./relations";
import { havePortraits } from "./portraits";
import type { EntityType } from "./types";

/**
 * The whole library as one graph.
 *
 * The per-entity diagram answers "who is around this person". This answers a
 * different question — what shape is the research as a whole — and the only
 * honest way to draw that is to let the connections decide the layout rather
 * than imposing one. So: a force simulation, run to rest on the server.
 *
 * It is deterministic. No randomness anywhere, including the starting
 * positions, because a map of your own material that rearranges itself on every
 * page load is a toy; one that always looks the same becomes something you can
 * remember and navigate by.
 */

export interface NetNode {
  id: number;
  name: string;
  type: EntityType;
  degree: number;
  mentions: number;
  hasPortrait: boolean;
  x: number;
  y: number;
  r: number;
}

export interface NetEdge {
  a: number;
  b: number;
  nature: Nature;
  colour: string;
  /** SVG dash pattern for this kind of tie; absent means solid. */
  dash?: string;
  type: string;
}

export interface Network {
  nodes: NetNode[];
  edges: NetEdge[];
  width: number;
  height: number;
  /** Entities left out because they hang off a single thread. */
  omitted: number;
  total: number;
}

export interface NetworkOptions {
  minDegree?: number;
  tagId?: number;
  nature?: Nature;
  /** Hard cap, so a runaway library cannot hang the page. */
  limit?: number;
}

/**
 * The canvas is sized to the graph, not the other way round.
 *
 * Fitting any number of nodes into one fixed rectangle is what made this
 * unreadable: two hundred entities scaled down until they sat on top of each
 * other. So the drawing gets the room it needs and the page scrolls, which is
 * how every other map works.
 */
const AREA_PER_NODE = 24_000;
const ASPECT = 1.6;
const MIN_WIDTH = 1200;
const MAX_WIDTH = 5200;
/** Clear space every node keeps around itself, on top of its own radius. */
const BREATHING_ROOM = 16;

function canvasFor(count: number): { width: number; height: number } {
  const area = Math.max(count, 1) * AREA_PER_NODE;
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(Math.sqrt(area * ASPECT))));
  return { width, height: Math.round(width / ASPECT) };
}

export function buildNetwork(opts: NetworkOptions = {}): Network {
  const minDegree = opts.minDegree ?? 3;
  const limit = opts.limit ?? 420;

  const rows = db()
    .prepare(
      `SELECT r.from_entity AS a, r.to_entity AS b, r.type
         FROM relations r
         JOIN entities ea ON ea.id = r.from_entity AND ea.merged_into IS NULL
         JOIN entities eb ON eb.id = r.to_entity   AND eb.merged_into IS NULL
        WHERE r.from_entity <> r.to_entity
          ${opts.tagId ? "AND (EXISTS (SELECT 1 FROM entity_tags t WHERE t.entity_id=ea.id AND t.tag_id=@tagId AND t.state='added') OR EXISTS (SELECT 1 FROM entity_tags t WHERE t.entity_id=eb.id AND t.tag_id=@tagId AND t.state='added'))" : ""}`
    )
    .all(opts.tagId ? { tagId: opts.tagId } : {}) as { a: number; b: number; type: string }[];

  const kept = opts.nature ? rows.filter((r) => natureOf(r.type).id === opts.nature) : rows;

  // One edge per pair, carrying the most consequential tie between them.
  const pairs = new Map<string, { a: number; b: number; type: string }>();
  for (const r of kept) {
    const key = `${Math.min(r.a, r.b)}:${Math.max(r.a, r.b)}`;
    const existing = pairs.get(key);
    if (!existing || rank(r.type) < rank(existing.type)) pairs.set(key, r);
  }

  const degree = new Map<number, number>();
  for (const p of pairs.values()) {
    degree.set(p.a, (degree.get(p.a) ?? 0) + 1);
    degree.set(p.b, (degree.get(p.b) ?? 0) + 1);
  }

  const total = degree.size;
  const ids = [...degree.entries()]
    .filter(([, d]) => d >= minDegree)
    .sort((x, y) => y[1] - x[1] || x[0] - y[0])
    .slice(0, limit)
    .map(([id]) => id);

  if (ids.length === 0) {
    const empty = canvasFor(0);
    return { nodes: [], edges: [], ...empty, omitted: total, total };
  }

  const set = new Set(ids);
  const meta = db()
    .prepare(
      `SELECT id, canonical_name, type,
              (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id = entities.id) AS mentions
         FROM entities WHERE id IN (${ids.map(() => "?").join(",")})`
    )
    .all(...ids) as { id: number; canonical_name: string; type: EntityType; mentions: number }[];

  const pictured = havePortraits();
  const maxDegree = Math.max(...ids.map((id) => degree.get(id) ?? 1));

  const nodes: NetNode[] = meta.map((m) => ({
    id: m.id,
    name: m.canonical_name,
    type: m.type,
    degree: degree.get(m.id) ?? 1,
    mentions: m.mentions,
    hasPortrait: pictured.has(m.id),
    x: 0,
    y: 0,
    // Area, not radius, follows degree: a hub with ten times the ties should
    // read as bigger, not as a planet swallowing its neighbours.
    r: 5 + 22 * Math.sqrt((degree.get(m.id) ?? 1) / maxDegree),
  }));

  const edges: NetEdge[] = [...pairs.values()]
    .filter((p) => set.has(p.a) && set.has(p.b))
    .map((p) => {
      const spec = natureOf(p.type);
      return { a: p.a, b: p.b, nature: spec.id, colour: spec.colour, dash: spec.dash, type: p.type };
    });

  const canvas = canvasFor(nodes.length);
  simulate(nodes, edges, canvas);
  separate(nodes);
  const extent = frame(nodes, canvas);

  return { nodes, edges, ...extent, omitted: total - nodes.length, total };
}

/**
 * Pushes overlapping nodes apart until none of them touch.
 *
 * The force pass alone does not guarantee this: repulsion falls off with the
 * square of the distance, so two nodes pulled together by a strong edge come to
 * rest on top of one another quite happily. This is a separate, purely
 * geometric pass — no springs, no gravity, just "you are inside me, move" —
 * which converges in a few dozen rounds and cannot pull the clusters apart
 * because it only ever acts on pairs that are actually overlapping.
 */
function separate(nodes: NetNode[], rounds = 90): void {
  const n = nodes.length;
  for (let pass = 0; pass < rounds; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const want = a.r + b.r + BREATHING_ROOM;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= want) continue;
        if (d < 0.01) {
          // Exactly coincident: separate along a fixed direction so the result
          // stays identical from one run to the next.
          dx = 1;
          dy = 0;
          d = 1;
        }
        const push = (want - d) / 2;
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/**
 * Moves the settled layout to the origin and reports how much room it took.
 *
 * Deliberately never scales. Scaling down to fit a fixed canvas is exactly what
 * put nodes back on top of each other after they had been separated; the canvas
 * grows to the drawing instead.
 */
function frame(nodes: NetNode[], canvas: { width: number; height: number }) {
  const pad = 40;
  const minX = Math.min(...nodes.map((d) => d.x - d.r));
  const minY = Math.min(...nodes.map((d) => d.y - d.r));

  for (const node of nodes) {
    node.x = Math.round((node.x - minX + pad) * 10) / 10;
    node.y = Math.round((node.y - minY + pad) * 10) / 10;
  }

  return {
    width: Math.max(canvas.width, Math.ceil(Math.max(...nodes.map((d) => d.x + d.r)) + pad)),
    height: Math.max(canvas.height, Math.ceil(Math.max(...nodes.map((d) => d.y + d.r)) + pad)),
  };
}

/** Which tie to keep when two entities are joined more than one way. */
const ORDER: Nature[] = [
  "kin", "ownership", "office", "conflict", "membership",
  "political", "authorship", "contact", "place", "other",
];
const rank = (type: string) => ORDER.indexOf(natureOf(type).id);

/**
 * A plain spring-and-repulsion simulation, run to rest.
 *
 * Nodes push each other apart, edges pull their ends together, and a weak pull
 * toward the middle stops disconnected clumps drifting off the canvas. Three
 * hundred passes is enough for a few hundred nodes to settle, and cooling the
 * step size over those passes is what stops it oscillating instead of resting.
 *
 * O(n²) per pass, deliberately: at a few hundred nodes that is a few million
 * operations and finishes in well under a second, and a quadtree would be more
 * code than the whole of this file for no gain at this size.
 */
function simulate(nodes: NetNode[], edges: NetEdge[], canvas: { width: number; height: number }): void {
  const n = nodes.length;
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  // Starting positions on a golden-angle spiral. Deterministic, and it spreads
  // nodes evenly enough that the simulation is not spending its first fifty
  // passes untangling a random pile.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const radius =
      30 + (Math.min(canvas.width, canvas.height) / 2 - 60) * Math.sqrt(i / Math.max(n - 1, 1));
    nodes[i].x = cx + radius * Math.cos(i * golden);
    nodes[i].y = cy + radius * Math.sin(i * golden);
  }

  const links = edges
    .map((e) => ({ a: index.get(e.a)!, b: index.get(e.b)! }))
    .filter((l) => l.a !== undefined && l.b !== undefined);

  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  // Hooke, not Hooke-times-distance. The spring was scaled by the separation
  // as well as by it, which makes a long edge overwhelmingly the strongest
  // force in the system: the graph collapsed into one blob and the clusters
  // that are the entire point of drawing it disappeared.
  const REPEL = 20000;
  const SPRING = 0.02;
  const REST = 130;
  const GRAVITY = 0.0016;
  const PASSES = 300;

  for (let pass = 0; pass < PASSES; pass++) {
    const cool = 1 - pass / PASSES;
    vx.fill(0);
    vy.fill(0);

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = nodes[i].x - nodes[j].x;
        let dy = nodes[i].y - nodes[j].y;
        let d2 = dx * dx + dy * dy;
        // Two nodes exactly on top of each other have no direction to separate
        // along; nudging them apart deterministically keeps it from dividing
        // by zero and from ever producing NaN.
        if (d2 < 1) {
          dx = ((i % 7) - 3) * 0.5 + 0.1;
          dy = ((j % 7) - 3) * 0.5 + 0.1;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        // Bigger nodes claim more room, so hubs do not sit on their satellites.
        const force = (REPEL * (1 + (nodes[i].r + nodes[j].r) / 40)) / d2;
        vx[i] += (dx / d) * force;
        vy[i] += (dy / d) * force;
        vx[j] -= (dx / d) * force;
        vy[j] -= (dy / d) * force;
      }
    }

    for (const l of links) {
      const dx = nodes[l.b].x - nodes[l.a].x;
      const dy = nodes[l.b].y - nodes[l.a].y;
      const d = Math.hypot(dx, dy) || 1;
      const force = (d - REST) * SPRING;
      vx[l.a] += (dx / d) * force;
      vy[l.a] += (dy / d) * force;
      vx[l.b] -= (dx / d) * force;
      vy[l.b] -= (dy / d) * force;
    }

    for (let i = 0; i < n; i++) {
      vx[i] += (cx - nodes[i].x) * GRAVITY * (1 + nodes[i].r / 20);
      vy[i] += (cy - nodes[i].y) * GRAVITY * (1 + nodes[i].r / 20);

      // Capped so one violent pass cannot fling a node across the canvas.
      const step = 12 * cool;
      const speed = Math.hypot(vx[i], vy[i]) || 1;
      const scale = Math.min(speed, step) / speed;
      nodes[i].x += vx[i] * scale;
      nodes[i].y += vy[i] * scale;
    }
  }
}

export interface Star {
  x: number;
  y: number;
  r: number;
  o: number;
}

/**
 * The field of faint points behind the graph.
 *
 * Generated rather than drawn, and from a fixed seed, because everything else
 * about this picture is reproducible — a background that reshuffled itself on
 * every render would be the one part of the map you could not navigate by.
 *
 * A plain linear congruential generator, not because the numbers need to be
 * good but because they need to be the *same* numbers in every runtime, which
 * `Math.random` cannot promise even when it takes a seed.
 */
export function starfield(width: number, height: number, count = 320, seed = 20260805): Star[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };

  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    const bright = next();
    stars.push({
      x: Math.round(next() * width * 10) / 10,
      y: Math.round(next() * height * 10) / 10,
      // Mostly dust with the occasional brighter point, so it reads as depth
      // rather than as an evenly speckled texture.
      r: Math.round((0.5 + bright * bright * 2) * 10) / 10,
      o: Math.round((0.1 + bright * 0.45) * 100) / 100,
    });
  }
  return stars;
}
