import type { NetNode, Network } from "./network";

/**
 * Focus layout: pure geometry, deliberately kept out of lib/network.ts.
 *
 * That module builds the graph from the database, so a client component that
 * imports anything from it by value drags better-sqlite3 into the browser
 * bundle and the build fails on `Can not resolve fs`. The type imports above
 * are erased at compile time and cost nothing. Same boundary as lib/video.ts.
 */

// ---------------------------------------------------------------------------
// Focus: gathering one entity's world around it
// ---------------------------------------------------------------------------

export interface Viewport {
  /** The visible area, in canvas units. */
  width: number;
  height: number;
  /** Where the middle of the visible area sits on the canvas. */
  cx: number;
  cy: number;
}

export interface Placement {
  x: number;
  y: number;
  /**
   * Whether this neighbour's name belongs above its dot rather than below.
   *
   * Decided here because only the layout knows which ring a node sits on, and
   * that is what the answer turns on: two nodes on adjacent rings can end up at
   * almost the same height, where their labels — horizontal boxes two hundred
   * pixels wide — overlap however far apart the rings are. Putting alternate
   * rings' names on alternate sides of their dots separates them vertically,
   * which no amount of extra radius would.
   */
  above?: boolean;
  /**
   * Extra distance to push the label, on top of the direction `above` gives.
   *
   * Radial placement alone is not enough near the horizontal, where "outward"
   * is sideways and does nothing to separate two rings vertically: a node on
   * the inner ring and one on the outer, both level with the subject, sit only
   * a ring-gap apart horizontally while their names are three times that wide.
   * Alternate rings therefore push their labels a line further out, so no two
   * rings ever write into the same horizontal band.
   */
  labelShift?: number;
}

/** Clear space between neighbours on a ring, beyond their own radii. */
const RING_GAP = 26;

/**
 * How much room along a ring one neighbour needs.
 *
 * The label is drawn centred under the dot at 12px, and the map clips names at
 * 26 characters. The 7.6px per character is not a guess: it is the same figure
 * the map itself uses to decide which names it can place without collision, and
 * the two must agree — a first attempt at 6.4 looked reasonable and still left
 * eight long names overlapping, because the ring was spaced for narrower text
 * than was actually drawn on it.
 */
function footprint(n: NetNode): number {
  const label = Math.min(n.name.length, 26) * 7.6 + 12;
  return Math.max(2 * n.r + RING_GAP, label);
}

/**
 * Ring geometry, done with chords rather than arc length.
 *
 * This is where the overlap actually came from, and it is subtle enough to be
 * worth spelling out. Spacing k labels evenly around a circle by arc length —
 * 2πr/k each — is the obvious calculation and the wrong one: a label is a
 * horizontal box, and what separates two of them is the straight line between
 * their centres, not the curve. Three items on a 100px ring are 209px apart
 * along the arc and only 173px apart in a straight line, so labels sized to the
 * arc still collided by thirty pixels.
 *
 * The chord between neighbours on a k-item ring is 2·r·sin(π/k), and these two
 * invert that: how many fit at a given radius, and how large a radius k of them
 * require.
 */
function capacity(radius: number, width: number): number {
  if (width >= 2 * radius) return 2;
  return Math.floor(Math.PI / Math.asin(width / (2 * radius)));
}

function radiusFor(count: number, width: number): number {
  if (count <= 1) return 0;
  return width / (2 * Math.sin(Math.PI / count));
}
/** How close the innermost ring sits to the entity at the centre. */
const FIRST_RING = 96;
/** Space between rings when there are more neighbours than one ring holds. */
const RING_STEP = 74;

/** One line of label, used to keep adjacent rings out of each other's band. */
const LABEL_LINE = 22;

/**
 * Where every node should sit while one entity has your attention.
 *
 * The map's ordinary layout answers "how does the whole library hang together",
 * and it answers it by spreading two hundred entities over a canvas several
 * screens wide. That is the right shape for browsing and the wrong one for a
 * question about one person: their eleven connections are scattered to four
 * corners, and reading them means scrolling around and losing your place.
 *
 * So selecting an entity rearranges the answer rather than the data. The
 * subject goes to the middle of what you are already looking at — not the
 * middle of the canvas, which might be somewhere else entirely — and everything
 * it touches is gathered into rings around it, sized so the whole cluster fits
 * on screen without moving. Nodes it does not touch are left exactly where they
 * are, because they fade out rather than move, and animating a hundred
 * irrelevant nodes to nowhere is both slower and more confusing than leaving
 * them be.
 *
 * Ordering is by degree, so the best-connected neighbours take the inner ring.
 * That is the useful arrangement: the people who matter most to this entity are
 * closest to it, and it is stable, since degree does not change between renders.
 */
export function focusLayout(
  network: Network,
  selectedId: number,
  view: Viewport
): Map<number, Placement> {
  const out = new Map<number, Placement>();
  const node = network.nodes.find((n) => n.id === selectedId);
  if (!node) return out;

  const byId = new Map(network.nodes.map((n) => [n.id, n]));
  const neighbourIds = new Set<number>();
  for (const e of network.edges) {
    if (e.a === selectedId) neighbourIds.add(e.b);
    else if (e.b === selectedId) neighbourIds.add(e.a);
  }
  neighbourIds.delete(selectedId);

  out.set(selectedId, { x: view.cx, y: view.cy });

  const neighbours = [...neighbourIds]
    .map((id) => byId.get(id))
    .filter((n): n is NetNode => Boolean(n))
    .sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name));
  if (!neighbours.length) return out;

  // Everything has to fit in what you can already see, so the rings are capped
  // by the viewport and then compressed to fit rather than allowed to run off
  // the edge — the entire promise of this view is that you need not scroll.
  const margin = Math.max(...neighbours.map((n) => n.r)) + 26;
  const maxRadius = Math.max(FIRST_RING, Math.min(view.width, view.height) / 2 - margin);

  const rings: NetNode[][] = [];
  let rest = neighbours;
  let radius = FIRST_RING;
  const radii: number[] = [];

  while (rest.length) {
    // Spaced by what each neighbour actually occupies, which is its *name* far
    // more often than its dot: a nine-pixel circle labelled "Organization of
    // Petroleum Exporting Countries" needs a great deal more room than
    // eighteen pixels. Sizing rings by the dots alone is what left the gathered
    // cluster looking like a pile of overlapping text.
    const widest = Math.max(...rest.slice(0, 40).map(footprint));

    // How many this ring can hold, and then — crucially — how big the ring has
    // to be to hold them. An earlier version forced a minimum of three onto a
    // ring with room for two and produced exactly the overlap it was meant to
    // prevent; the floor belongs on the radius, not on the count.
    const take = Math.min(rest.length, Math.max(3, capacity(radius, widest)));
    radius = Math.max(radius, radiusFor(take, widest));
    rings.push(rest.slice(0, take));
    radii.push(radius);
    rest = rest.slice(take);
    radius += RING_STEP;
  }

  /**
   * Squeeze the whole set inwards if it grew past what is visible — but never
   * past the point where the names start colliding again.
   *
   * These two goals genuinely conflict for a very well-connected subject: the
   * cluster cannot always be both entirely on screen and entirely legible. When
   * it cannot, legibility wins and the map is left scrollable, because a ring
   * of forty overlapping names is not a view of anything. A pile that fits on
   * screen is worse than a readable arrangement you have to scroll.
   */
  const outermost = radii[radii.length - 1];
  const wanted = outermost > maxRadius ? maxRadius / outermost : 1;
  const floor = Math.max(
    ...rings.map((ring, i) => {
      const need = radiusFor(ring.length, Math.max(...ring.map(footprint)));
      return need > 0 ? Math.min(1, need / radii[i]) : 0;
    })
  );
  const squeeze = Math.max(wanted, floor);

  rings.forEach((ring, i) => {
    const r = radii[i] * squeeze;
    // Alternate rings are offset by half a step so neighbours on adjacent
    // rings do not line up into spokes.
    const offset = i % 2 === 0 ? 0 : Math.PI / ring.length;
    ring.forEach((n, k) => {
      const angle = (2 * Math.PI * k) / ring.length + offset - Math.PI / 2;
      out.set(n.id, {
        x: view.cx + Math.cos(angle) * r,
        y: view.cy + Math.sin(angle) * r,
        // Outward from the subject, never inward. Alternating by ring instead
        // looked tidier and was worse: it pointed each ring's names straight at
        // the ring beside it, so labels met in the gap between them. Radially
        // outward, the gap between rings is always clear.
        above: Math.sin(angle) < 0,
        // Growing outward with each ring, not alternating. Alternating pushed
        // an inner ring's label *towards* the outer ring rather than away from
        // it, which made the collision it was meant to prevent slightly worse.
        // Capped, so a fourth ring does not fling its names into the margin.
        labelShift: Math.min(i, 2) * LABEL_LINE,
      });
    });
  });

  return out;
}

/** Everything one entity is tied to, including itself. */
export function neighbourhood(network: Network, selectedId: number): Set<number> {
  const set = new Set<number>([selectedId]);
  for (const e of network.edges) {
    if (e.a === selectedId) set.add(e.b);
    else if (e.b === selectedId) set.add(e.a);
  }
  return set;
}
