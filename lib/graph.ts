import type { EntityType } from "./types";
import { NATURES, generation, kinRole, natureOf, type Nature } from "./relations";

/**
 * Layout for the connections diagram.
 *
 * Kept out of the component and free of React so it can be tested: the whole
 * value of this drawing is that the same person always looks the same, and that
 * only holds if the arithmetic is pinned down.
 *
 * The shape is a bundled radial graph. Neighbours sit on one ring, grouped into
 * contiguous arcs by the *nature* of their tie, so the proportions of a life are
 * readable before you have read a single name — a wide red arc is someone whose
 * record is mostly conflict, a wide brown one someone whose record is mostly
 * money. Spokes leave the centre bundled by group and splay out to their
 * neighbour. Ties *between* neighbours are drawn as chords across the middle,
 * which is what turns a star into a web.
 */

export interface Connection {
  id: number;
  type: string;
  quote: string | null;
  direction: "in" | "out";
  other_id: number;
  other_name: string;
  other_type: EntityType;
  other_weight?: number;
}

export interface NetworkTie {
  id: number;
  type: string;
  quote: string | null;
  a: number;
  b: number;
}

/**
 * Canvas. A square viewBox keeps the maths trivial and scales to any width.
 *
 * The ring sits well inside it. Names are the thing you actually read here, so
 * the geometry is arranged around giving them room at a legible size rather
 * than around filling the circle: a tight ring with a wide margin renders text
 * larger than a wide ring with a tight one, for the same drawing on screen.
 */
export const VIEW = 1200;
export const C = VIEW / 2;
/** Where neighbour nodes sit. */
export const RING = 250;
/** How far in the spoke bundles pinch before fanning out. */
const HUB = 82;
/** The nature band, outside the labels. */
export const BAND = 545;
const BAND_W = 11;

/** Biggest a node can get, which is where its label has to start. */
export const MAX_R = 12;
/** Gap between the longest label and the band. */
const LABEL_GAP = 9;
/**
 * How wide a character runs at the label's font size, in user units. Measured
 * from the rendered page (5.6 per character at font 11.5, so ~0.49 per point)
 * and rounded up hard, because the name that overruns the band will be the
 * all-caps acronym, not the average.
 */
export const LABEL_SIZE = 16;
export const CHAR_W = LABEL_SIZE * 0.63;
/** As many characters as fit between the ring and the band. */
export const MAX_LABEL = Math.floor((BAND - LABEL_GAP - (RING + MAX_R + 9)) / CHAR_W);

/** Gap between adjacent nature arcs, in radians. */
const GAP = 0.075;
/**
 * Beyond this the ring stops being readable, so the tail is folded away. Set by
 * the label height: names are ~1.4× the font size tall, and two of them may not
 * share the same slice of the ring.
 */
export const MAX_NODES = Math.floor((2 * Math.PI * RING) / (LABEL_SIZE * 1.45));

const SHAPE: Record<string, "circle" | "square" | "diamond"> = {
  person: "circle",
  org: "square",
  institution: "square",
  work: "square",
  place: "diamond",
  event: "diamond",
  concept: "diamond",
};

export interface Node {
  entityId: number;
  name: string;
  label: string;
  entityType: EntityType;
  shape: "circle" | "square" | "diamond";
  nature: Nature;
  colour: string;
  relations: Connection[];
  /** Mentions across the library — how big a presence this neighbour is. */
  weight: number;
  generation: -1 | 0 | 1;
  angle: number;
  x: number;
  y: number;
  r: number;
  /** Ready-made transform for a tangential label, and its anchor. */
  labelTransform: string;
  labelAnchor: "start" | "end";
  spoke: string;
  /** Total documented relations, which sets the spoke's weight. */
  strength: number;
}

export interface Band {
  nature: Nature;
  label: string;
  note: string;
  colour: string;
  count: number;
  from: number;
  to: number;
  /** The coloured arc itself, and an inner path to hang its label on. */
  arc: string;
  labelPath: string;
  /** Left half of the circle: the label has to be flipped to read. */
  flipped: boolean;
}

export interface Chord {
  id: number;
  a: number;
  b: number;
  type: string;
  quote: string | null;
  colour: string;
  path: string;
}

export interface Layout {
  nodes: Node[];
  bands: Band[];
  chords: Chord[];
  /** Neighbours dropped to keep the ring readable. */
  hidden: number;
  total: number;
}

const ORDER: Nature[] = [
  "kin",
  "ownership",
  "office",
  "membership",
  "political",
  "conflict",
  "authorship",
  "contact",
  "place",
  "other",
];

export function point(angle: number, radius: number): [number, number] {
  return [C + radius * Math.cos(angle), C + radius * Math.sin(angle)];
}

const f = (n: number) => Math.round(n * 100) / 100;
const xy = (angle: number, radius: number) => {
  const [x, y] = point(angle, radius);
  return `${f(x)} ${f(y)}`;
};

/** Names have to fit between the ring and the band, so they get clipped. */
export function clip(name: string, max = MAX_LABEL): string {
  return name.length <= max ? name : `${name.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A neighbour's nature is the most consequential of its ties. Someone who is
 * both your brother and your business partner belongs in Family: the rarer,
 * more explanatory fact is the one worth drawing.
 */
export function dominantNature(rels: Connection[]): { id: Nature; colour: string } {
  const specs = rels.map((r) => natureOf(r.type));
  const best =
    specs.find((s) => s.id === "kin") ??
    specs.find((s) => s.id === "ownership") ??
    specs.find((s) => s.id === "office") ??
    specs.find((s) => s.id !== "other") ??
    specs[0];
  return { id: best.id, colour: best.colour };
}

/**
 * Family is drawn as a tree of its own, so by default it is left out of the
 * ring — a relative appearing in both places reads as two different people.
 */
export function layout(
  connections: Connection[],
  network: NetworkTie[] = [],
  opts: { withKin?: boolean } = {}
): Layout {
  // One node per entity, however many relations join it to the centre.
  const byEntity = new Map<number, Connection[]>();
  for (const c of connections) {
    const list = byEntity.get(c.other_id);
    if (list) list.push(c);
    else byEntity.set(c.other_id, [c]);
  }

  interface Draft {
    entityId: number;
    name: string;
    entityType: EntityType;
    nature: Nature;
    colour: string;
    relations: Connection[];
    weight: number;
    generation: -1 | 0 | 1;
  }

  const drafts: Draft[] = [...byEntity.entries()]
    .map(([entityId, rels]) => {
      const best = dominantNature(rels);
      const kinRel = rels.find((r) => natureOf(r.type).id === "kin");
      return {
        entityId,
        name: rels[0].other_name,
        entityType: rels[0].other_type,
        nature: best.id,
        colour: best.colour,
        relations: rels,
        weight: rels[0].other_weight ?? rels.length,
        generation: kinRel ? generation(kinRel.type, kinRel.direction) : 0,
      };
    })
    .filter((d) => opts.withKin || d.nature !== "kin");

  const total = drafts.length;

  // Too many names on one ring is the hairball this replaced. Keep the ones
  // the library actually has most to say about; the list underneath keeps all
  // of them, so nothing is lost, only undrawn.
  const kept = [...drafts]
    .sort(
      (a, b) =>
        b.relations.length - a.relations.length ||
        b.weight - a.weight ||
        a.name.localeCompare(b.name)
    )
    .slice(0, MAX_NODES);
  const hidden = total - kept.length;

  const groups = ORDER.map((id) => ({
    spec: NATURES[id],
    members: kept
      .filter((n) => n.nature === id)
      // Heaviest first inside a group, so the eye lands on the ones that matter
      // at the leading edge of each arc rather than hunting.
      .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name)),
  })).filter((g) => g.members.length > 0);

  const shown = groups.reduce((n, g) => n + g.members.length, 0);
  const usable = Math.PI * 2 - GAP * groups.length;
  const maxWeight = Math.max(1, ...kept.map((n) => n.weight));

  const nodes: Node[] = [];
  const bands: Band[] = [];

  // Start at the top and run clockwise, so reading order matches a clock face.
  let cursor = -Math.PI / 2 + GAP / 2;

  for (const g of groups) {
    const span = (g.members.length / shown) * usable;
    const from = cursor;
    const to = cursor + span;
    const mid = (from + to) / 2;
    const slot = span / g.members.length;

    for (const [i, m] of g.members.entries()) {
      const angle = from + slot * (i + 0.5);
      const [x, y] = point(angle, RING);
      // Area, not radius, tracks presence — a doubling of mentions should not
      // quadruple the ink.
      const r = 4.5 + (MAX_R - 4.5) * Math.sqrt(m.weight / maxWeight);
      const flipped = Math.cos(angle) < 0;
      const labelR = RING + r + 9;
      const deg = f((angle * 180) / Math.PI);

      nodes.push({
        ...m,
        label: clip(m.name),
        shape: SHAPE[m.entityType] ?? "circle",
        angle,
        x: f(x),
        y: f(y),
        r: f(r),
        labelTransform: flipped
          ? `translate(${C} ${C}) rotate(${deg}) translate(${f(labelR)} 0) rotate(180)`
          : `translate(${C} ${C}) rotate(${deg}) translate(${f(labelR)} 0)`,
        labelAnchor: flipped ? "end" : "start",
        strength: m.relations.length,
        // Both control points sit on the group's mid-angle, so every spoke in a
        // group leaves the hub along the same line and only separates near the
        // ring. That is what keeps forty spokes from reading as noise.
        spoke: `M ${C} ${C} C ${xy(mid, HUB)} ${xy(mid, RING * 0.62)} ${xy(angle, RING - r)}`,
      });
    }

    const large = span > Math.PI ? 1 : 0;
    // y grows downward, so a positive sine puts the arc below the centre.
    const below = Math.sin(mid) > 0;
    bands.push({
      nature: g.spec.id,
      label: g.spec.label,
      note: g.spec.note,
      colour: g.spec.colour,
      count: g.members.length,
      from,
      to,
      arc:
        `M ${xy(from, BAND)} A ${BAND} ${BAND} 0 ${large} 1 ${xy(to, BAND)}` +
        ` L ${xy(to, BAND - BAND_W)} A ${BAND - BAND_W} ${BAND - BAND_W} 0 ${large} 0 ${xy(from, BAND - BAND_W)} Z`,
      // Text set on a clockwise arc reads the right way up across the top of a
      // circle and upside down across the bottom, so arcs below the centre get
      // their path reversed. The test that matters is which *half* the arc sits
      // in vertically — an earlier version asked whether it was on the left,
      // which left every label in the top-left corner standing on its head.
      labelPath: below
        ? `M ${xy(to, BAND + 17)} A ${BAND + 17} ${BAND + 17} 0 ${large} 0 ${xy(from, BAND + 17)}`
        : `M ${xy(from, BAND + 7)} A ${BAND + 7} ${BAND + 7} 0 ${large} 1 ${xy(to, BAND + 7)}`,
      flipped: below,
    });

    cursor = to + GAP;
  }

  // Chords: ties between two neighbours, bowed through the centre. Drawn faint
  // until you hover one of their ends.
  const placed = new Map(nodes.map((n) => [n.entityId, n]));
  const chords: Chord[] = [];
  const seen = new Set<string>();
  for (const t of network) {
    const a = placed.get(t.a);
    const b = placed.get(t.b);
    if (!a || !b || a.entityId === b.entityId) continue;
    const key = `${Math.min(t.a, t.b)}:${Math.max(t.a, t.b)}:${t.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Pull the control point toward the centre by how far apart the ends are:
    // near neighbours get a shallow bow, opposites cut straight across.
    const spread = Math.abs(Math.atan2(Math.sin(a.angle - b.angle), Math.cos(a.angle - b.angle)));
    const pull = 1 - spread / Math.PI;
    // Bisector by vector sum, so the bow never flips to the far side of the
    // circle when the two ends straddle the top of the ring.
    const bisector = Math.atan2(
      Math.sin(a.angle) + Math.sin(b.angle),
      Math.cos(a.angle) + Math.cos(b.angle)
    );
    const [mx, my] = point(bisector, RING * pull * 0.55);
    chords.push({
      id: t.id,
      a: t.a,
      b: t.b,
      type: t.type,
      quote: t.quote,
      colour: natureOf(t.type).colour,
      path: `M ${a.x} ${a.y} Q ${f(mx)} ${f(my)} ${b.x} ${b.y}`,
    });
  }

  return { nodes, bands, chords, hidden, total };
}

// ---------------------------------------------------------------------------
// Family
// ---------------------------------------------------------------------------

export interface TreeBox {
  entityId: number;
  name: string;
  label: string;
  relations: Connection[];
  generation: -1 | 0 | 1;
  /** True for the subject of the page, which has no entity of its own here. */
  self: boolean;
  /** What this person is to the subject: "parent", "spouse", "child". */
  role: string | null;
  /** Captions sit on the side of the box facing away from the connectors. */
  captionAbove: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Tree {
  boxes: TreeBox[];
  /** Square connectors, for descent. */
  links: string[];
  /** Curves, for ties within a generation. */
  arcs: string[];
  width: number;
  height: number;
  /** Relatives the sources place, but not above or below. */
  asideCount: number;
}

const BOX_H = 46;
const BOX_GAP = 24;
const ROW_GAP = 88;
const TREE_CHAR = 8.4;
const TREE_PAD = 26;
const TREE_MARGIN = 30;
/** How far the same-generation curves dip below their row. */
const ARC_DIP = 24;
const TREE_LABEL = 28;

const boxWidth = (name: string) => Math.max(116, Math.round(name.length * TREE_CHAR) + TREE_PAD);

/**
 * Family drawn as a family tree: generations in rows, joined by the square
 * connectors a pedigree chart uses, rather than as another ring.
 *
 * Generation is only assigned where the phrasing is explicit ("son of", "father
 * of"). Everything else — spouses, siblings, and anything vague — sits on the
 * subject's own row. A guessed generation is a claim the sources did not make.
 *
 * Two kinds of line, because they mean different things. Descent is drawn
 * square, through a shared horizontal bus, the way a pedigree chart draws it.
 * Ties within a generation are drawn as curves that dip below the row and
 * return, each running from the subject to one relative. They used to be
 * straight lines along the row, which passed clean through whichever boxes sat
 * between and read as a chain — the sources said a man was the subject's
 * brother and the picture said he was his wife's.
 */
export function familyTree(connections: Connection[], centreName: string): Tree | null {
  const byEntity = new Map<number, Connection[]>();
  for (const c of connections) {
    if (natureOf(c.type).id !== "kin") continue;
    const list = byEntity.get(c.other_id);
    if (list) list.push(c);
    else byEntity.set(c.other_id, [c]);
  }
  if (byEntity.size === 0) return null;

  const people = [...byEntity.entries()].map(([entityId, rels]) => ({
    entityId,
    name: rels[0].other_name,
    relations: rels,
    generation: generation(rels[0].type, rels[0].direction),
    role: kinRole(rels[0].type, rels[0].direction),
  }));

  const above = people.filter((p) => p.generation === -1);
  const aside = people.filter((p) => p.generation === 0);
  const below = people.filter((p) => p.generation === 1);

  const selfW = boxWidth(clip(centreName, TREE_LABEL));
  const widthOf = (items: { name: string }[], extra = 0) => {
    const parts = items.map((p) => boxWidth(clip(p.name, TREE_LABEL)));
    if (extra) parts.push(extra);
    return parts.reduce((a, b) => a + b, 0) + BOX_GAP * Math.max(parts.length - 1, 0);
  };

  const width =
    Math.max(widthOf(above), widthOf(aside, selfW), widthOf(below), selfW) + TREE_MARGIN * 2;

  // Rows only exist where there is someone in them, so a subject with only
  // children does not get an empty band of whitespace above.
  const rows = [above.length > 0, true, below.length > 0];
  const shownRows = rows.filter(Boolean).length;
  const bottomPad = below.length > 0 ? 22 : aside.length > 0 ? ARC_DIP + 6 : 8;
  const height =
    TREE_MARGIN * 2 + bottomPad + BOX_H * shownRows + ROW_GAP * (shownRows - 1);

  const boxes: TreeBox[] = [];
  let y = TREE_MARGIN;

  const place = (
    items: typeof people,
    gen: -1 | 0 | 1,
    withSelf: boolean,
    captionAbove: boolean
  ) => {
    // The subject sits in the middle of its own row rather than at one end, so
    // the curves to its relatives fan out both ways instead of all reaching
    // across the whole picture in one direction.
    const left: typeof people = [];
    const right: typeof people = [];
    items.forEach((p, i) => (i % 2 === 0 ? right.push(p) : left.unshift(p)));

    const ordered: (typeof people[number] | null)[] = withSelf
      ? [...left, null, ...right]
      : [...items];

    const total = widthOf(items, withSelf ? selfW : 0);
    let x = (width - total) / 2;

    for (const p of ordered) {
      if (p === null) {
        boxes.push({
          entityId: -1,
          name: centreName,
          label: clip(centreName, TREE_LABEL),
          relations: [],
          generation: gen,
          self: true,
          role: null,
          captionAbove,
          x,
          y,
          w: selfW,
          h: BOX_H,
        });
        x += selfW + BOX_GAP;
        continue;
      }
      const w = boxWidth(clip(p.name, TREE_LABEL));
      boxes.push({
        ...p,
        label: clip(p.name, TREE_LABEL),
        self: false,
        captionAbove,
        x,
        y,
        w,
        h: BOX_H,
      });
      x += w + BOX_GAP;
    }
    y += BOX_H + ROW_GAP;
  };

  // Captions face away from where that box's connectors leave it.
  if (rows[0]) place(above, -1, false, true);
  place(aside, 0, true, true);
  if (rows[2]) place(below, 1, false, false);

  const self = boxes.find((b) => b.self)!;
  const selfMid = self.x + self.w / 2;
  const links: string[] = [];
  const arcs: string[] = [];

  /**
   * A horizontal bus halfway between two rows, with a drop from each box onto
   * it — the shape a pedigree chart uses, and the reason this is legible as
   * descent rather than as association.
   */
  const join = (from: TreeBox[], isAbove: boolean) => {
    if (from.length === 0) return;
    const rowTop = from[0].y;
    const busY = isAbove ? rowTop + BOX_H + ROW_GAP / 2 : rowTop - ROW_GAP / 2;
    const xs = from.map((b) => b.x + b.w / 2);
    const left = Math.min(...xs, selfMid);
    const right = Math.max(...xs, selfMid);

    links.push(`M ${f(left)} ${f(busY)} L ${f(right)} ${f(busY)}`);
    for (const b of from) {
      const cx = f(b.x + b.w / 2);
      links.push(
        isAbove ? `M ${cx} ${f(b.y + BOX_H)} L ${cx} ${f(busY)}` : `M ${cx} ${f(b.y)} L ${cx} ${f(busY)}`
      );
    }
    links.push(
      isAbove
        ? `M ${f(selfMid)} ${f(busY)} L ${f(selfMid)} ${f(self.y)}`
        : `M ${f(selfMid)} ${f(self.y + BOX_H)} L ${f(selfMid)} ${f(busY)}`
    );
  };

  join(boxes.filter((b) => b.generation === -1), true);
  join(boxes.filter((b) => b.generation === 1), false);

  // Each same-row relative gets its own curve to the subject, dipping below the
  // row. Curves of different spans nest instead of overlapping, and none of
  // them crosses a box.
  const foot = self.y + BOX_H;
  for (const b of boxes.filter((x) => x.generation === 0 && !x.self)) {
    const bx = b.x + b.w / 2;
    const mid = (selfMid + bx) / 2;
    arcs.push(`M ${f(selfMid)} ${f(foot)} Q ${f(mid)} ${f(foot + ARC_DIP * 2)} ${f(bx)} ${f(foot)}`);
  }

  return { boxes, links, arcs, width, height, asideCount: aside.length };
}
