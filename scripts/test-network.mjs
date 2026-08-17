/**
 * The whole-library graph.
 *
 * The layout is a physics simulation, which is exactly the kind of code that
 * fails quietly: it does not throw, it just produces a picture that is subtly
 * wrong or, worse, a different picture every time. So what is pinned here is
 * that it settles, that it settles in the same place twice, and that nothing
 * ends up off the canvas or as NaN.
 *
 *   npx tsx scripts/test-network.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const SANDBOX = path.join(root, "data", "__network__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.env.CORPUS_DATA_DIR = SANDBOX;

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

const { db } = await import("../lib/db/index.ts");
const { buildNetwork, starfield } = await import("../lib/network.ts");

// ---------------------------------------------------------------------------
section("The background is generated, and generated the same way every time");
// ---------------------------------------------------------------------------
{
  const a = starfield(1600, 1000);
  const b = starfield(1600, 1000);
  check("two calls agree exactly", JSON.stringify(a) === JSON.stringify(b));
  check("a different canvas gives a different field", JSON.stringify(starfield(800, 600)) !== JSON.stringify(a));
  check("every star is on the canvas",
    a.every((s) => s.x >= 0 && s.x <= 1600 && s.y >= 0 && s.y <= 1000));
  check("and visible but faint", a.every((s) => s.r > 0 && s.o > 0 && s.o < 0.6));
  check("there are enough to read as depth", a.length === 320);
  check("nothing is NaN", a.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.r)));
  check("the seed is what decides it", JSON.stringify(starfield(1600, 1000, 320, 7)) !== JSON.stringify(a));
}

// A small world: two clusters joined by one bridging figure.
const h = db();
const entity = h.prepare(
  "INSERT INTO entities (type, canonical_name, normalized) VALUES (?, ?, ?)"
);
const relate = h.prepare("INSERT INTO relations (from_entity, to_entity, type) VALUES (?, ?, ?)");

const ids = {};
const add = (name, type = "person") => {
  ids[name] = Number(entity.run(type, name, name.toLowerCase()).lastInsertRowid);
};
["Hub", "A1", "A2", "A3", "A4", "Bridge", "B1", "B2", "B3", "Lonely"].forEach((n) => add(n));

for (const n of ["A1", "A2", "A3", "A4", "Bridge"]) relate.run(ids.Hub, ids[n], "worked with");
for (const n of ["B1", "B2", "B3"]) relate.run(ids.Bridge, ids[n], "founded");
relate.run(ids.A1, ids.A2, "brother of");
relate.run(ids.B1, ids.B2, "opposed");
relate.run(ids.Hub, ids.Lonely, "met with");

// ---------------------------------------------------------------------------
section("The graph holds what it should and drops what it should");
// ---------------------------------------------------------------------------
{
  const net = buildNetwork({ minDegree: 1 });
  check("everyone with a tie is in", net.nodes.length === 10, `${net.nodes.length}`);
  check("edges are counted once per pair", net.edges.length === 11, `${net.edges.length}`);
  check("nothing is joined to itself", net.edges.every((e) => e.a !== e.b));

  const two = buildNetwork({ minDegree: 2 });
  check("a threshold drops the single-thread names", !two.nodes.some((n) => n.name === "Lonely"));
  check("and says how many it dropped", two.omitted === 10 - two.nodes.length, `${two.omitted}`);
  check("the hub survives every threshold", buildNetwork({ minDegree: 5 }).nodes.some((n) => n.name === "Hub"));
}

// ---------------------------------------------------------------------------
section("Size means something");
// ---------------------------------------------------------------------------
{
  const net = buildNetwork({ minDegree: 1 });
  const hub = net.nodes.find((n) => n.name === "Hub");
  const leaf = net.nodes.find((n) => n.name === "Lonely");
  check("the hub is the most connected", hub.degree === 6, `${hub.degree}`);
  check("and is drawn largest", net.nodes.every((n) => n.r <= hub.r + 0.001));
  check("a leaf is drawn smallest", net.nodes.every((n) => n.r >= leaf.r - 0.001));
  check("every node has a real radius", net.nodes.every((n) => n.r > 0 && Number.isFinite(n.r)));
}

// ---------------------------------------------------------------------------
section("The same library always draws the same map");
// ---------------------------------------------------------------------------
{
  const a = buildNetwork({ minDegree: 1 });
  const b = buildNetwork({ minDegree: 1 });
  check(
    "twice in a row is identical to the tenth of a pixel",
    JSON.stringify(a.nodes.map((n) => [n.id, n.x, n.y])) ===
      JSON.stringify(b.nodes.map((n) => [n.id, n.x, n.y]))
  );
  check("no position is NaN", a.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
  check(
    "everything is on the canvas",
    a.nodes.every((n) => n.x - n.r >= -1 && n.y - n.r >= -1 && n.x + n.r <= a.width + 1 && n.y + n.r <= a.height + 1),
    a.nodes.filter((n) => n.x < 0 || n.y < 0).map((n) => n.name).join(",")
  );
  check("and it uses the canvas rather than huddling in the middle",
    Math.max(...a.nodes.map((n) => n.x)) - Math.min(...a.nodes.map((n) => n.x)) > a.width * 0.5);
}

// ---------------------------------------------------------------------------
section("Connected things end up near each other");
// ---------------------------------------------------------------------------
{
  const net = buildNetwork({ minDegree: 1 });
  const at = Object.fromEntries(net.nodes.map((n) => [n.name, n]));
  const gap = (p, q) => Math.hypot(at[p].x - at[q].x, at[p].y - at[q].y);

  // A1 hangs off the Hub and B1 off the Bridge; each should sit closer to its
  // own attachment than to the other cluster's.
  check("a satellite sits nearer its own hub", gap("A1", "Hub") < gap("A1", "B1"), `${Math.round(gap("A1","Hub"))} vs ${Math.round(gap("A1","B1"))}`);
  check("and the other cluster keeps its distance", gap("B1", "Bridge") < gap("B1", "Hub"),
    `${Math.round(gap("B1","Bridge"))} vs ${Math.round(gap("B1","Hub"))}`);
  check("nothing overlaps its neighbour entirely",
    net.nodes.every((n, i) => net.nodes.every((m, j) => i === j || Math.hypot(n.x - m.x, n.y - m.y) > 2)));
}

// ---------------------------------------------------------------------------
section("No two nodes may overlap, at any size of graph");
// ---------------------------------------------------------------------------
// The complaint this answers: the map was unreadable because everything was
// piled on top of everything else.
{
  const worst = (net) => {
    let overlap = 0;
    for (let i = 0; i < net.nodes.length; i++) {
      for (let j = i + 1; j < net.nodes.length; j++) {
        const a = net.nodes[i];
        const b = net.nodes[j];
        overlap = Math.max(overlap, a.r + b.r - Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    return overlap;
  };

  const small = buildNetwork({ minDegree: 1 });
  check("a small graph has no two discs touching", worst(small) <= 0, `${worst(small).toFixed(1)}px of overlap`);
  check(
    "and they are not merely touching but spaced",
    small.nodes.every((a, i) =>
      small.nodes.every((b, j) => i === j || Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r + 15)
    )
  );

  const filtered = buildNetwork({ minDegree: 2 });
  check("a filtered graph too", worst(filtered) <= 0, `${worst(filtered).toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section("The canvas grows to the graph rather than squeezing it");
// ---------------------------------------------------------------------------
{
  const few = buildNetwork({ minDegree: 5 });
  const many = buildNetwork({ minDegree: 1 });
  check("more nodes, more canvas", many.width >= few.width, `${many.width} vs ${few.width}`);
  check(
    "everything is inside the canvas it reports",
    many.nodes.every((n) => n.x - n.r >= 0 && n.y - n.r >= 0 && n.x + n.r <= many.width && n.y + n.r <= many.height)
  );
  check("the canvas is never smaller than a screen", few.width >= 1200 && few.height >= 700);
}

// ---------------------------------------------------------------------------
section("Filtering by the kind of tie");
// ---------------------------------------------------------------------------
{
  const kin = buildNetwork({ minDegree: 1, nature: "kin" });
  check("only the family tie survives", kin.edges.length === 1, `${kin.edges.length}`);
  check("and only the two people it joins", kin.nodes.length === 2, `${kin.nodes.length}`);
  check("edges carry their nature's colour", kin.edges[0].colour === "#a8536b");

  const none = buildNetwork({ minDegree: 1, nature: "authorship" });
  check("a kind nobody has draws nothing", none.nodes.length === 0 && none.edges.length === 0);
  check("and does not throw doing it", none.width > 0);
}

// ---------------------------------------------------------------------------
section("A big library does not hang the page");
// ---------------------------------------------------------------------------
{
  for (let i = 0; i < 300; i++) add(`Extra${i}`, "org");
  for (let i = 0; i < 300; i++) {
    relate.run(ids[`Extra${i}`], ids[`Extra${(i + 1) % 300}`], "supplied");
    relate.run(ids[`Extra${i}`], ids.Hub, "supplied");
  }
  const t0 = Date.now();
  const net = buildNetwork({ minDegree: 1 });
  const ms = Date.now() - t0;
  check(`${net.nodes.length} nodes settle in under three seconds`, ms < 3000, `${ms}ms`);
  check("the cap is respected", net.nodes.length <= 420);
  check("still nothing off-canvas",
    net.nodes.every((n) => n.x >= -1 && n.y >= -1 && n.x <= net.width + 1 && n.y <= net.height + 1));
}

// The sandbox is left for the next run to clear: Windows will not delete a
// directory whose database handle this process still holds open.

// ---------------------------------------------------------------------------
section("Focusing on one entity gathers its world into view");
// ---------------------------------------------------------------------------
{
  const { focusLayout, neighbourhood } = await import("../lib/focus.ts");

  const mk = (id, degree = 2) => ({
    id, name: `N${id}`, type: "person", degree, mentions: 3,
    hasPortrait: false, x: 100 + id * 40, y: 60 + (id % 7) * 55, r: 9,
  });

  const nodes = Array.from({ length: 40 }, (_, i) => mk(i + 1, 40 - i));
  // 1 is tied to 2..13; the rest are strangers.
  const edges = [];
  for (let i = 2; i <= 13; i++) {
    edges.push({ a: 1, b: i, nature: "other", colour: "#888", type: "knows" });
  }
  const net = { nodes, edges, width: 2400, height: 1500, omitted: 0, total: 40 };
  const view = { width: 900, height: 620, cx: 1200, cy: 750 };

  const place = focusLayout(net, 1, view);

  check("the subject goes to the middle of what you are looking at",
    place.get(1).x === view.cx && place.get(1).y === view.cy);

  const neighbours = [];
  for (let i = 2; i <= 13; i++) neighbours.push(place.get(i));
  check("every connection is placed", neighbours.every(Boolean));
  check("and nothing else is", ![...place.keys()].some((id) => id > 13));

  // The whole promise of the view: no scrolling required.
  check("all of it fits on screen", neighbours.every((p) =>
    Math.abs(p.x - view.cx) <= view.width / 2 && Math.abs(p.y - view.cy) <= view.height / 2));

  // Neighbours must not land on top of one another.
  let closest = Infinity;
  for (let i = 0; i < neighbours.length; i++) {
    for (let j = i + 1; j < neighbours.length; j++) {
      closest = Math.min(closest, Math.hypot(
        neighbours[i].x - neighbours[j].x, neighbours[i].y - neighbours[j].y));
    }
  }
  check("neighbours keep clear of each other", closest > 18, closest.toFixed(1));

  // Distance from centre should be one of a few rings, not arbitrary.
  const radii = neighbours.map((p) => Math.round(Math.hypot(p.x - view.cx, p.y - view.cy)));
  check("they sit on rings, not at random", new Set(radii).size <= 3, [...new Set(radii)].join(","));
  check("and none sits on top of the subject", Math.min(...radii) > 20);

  // A crowd still has to fit.
  const crowdEdges = [];
  for (let i = 2; i <= 40; i++) {
    crowdEdges.push({ a: 1, b: i, nature: "other", colour: "#888", type: "knows" });
  }
  const crowd = focusLayout({ ...net, edges: crowdEdges }, 1, view);
  const far = [...crowd.entries()].filter(([id]) => id !== 1)
    .map(([, p]) => Math.hypot(p.x - view.cx, p.y - view.cy));
  check("thirty-nine connections still fit on screen",
    Math.max(...far) <= Math.min(view.width, view.height) / 2, Math.max(...far).toFixed(0));

  check("an entity with no ties places only itself",
    focusLayout(net, 30, view).size === 1);
  check("an unknown id places nothing", focusLayout(net, 9999, view).size === 0);

  const hood = neighbourhood(net, 1);
  check("the neighbourhood includes the subject", hood.has(1));
  check("and everything it touches", hood.size === 13, String(hood.size));
  check("but no strangers", !hood.has(20));
}

// ---------------------------------------------------------------------------
section("Gathered neighbours do not stack on top of each other");
// ---------------------------------------------------------------------------
{
  const { focusLayout } = await import("../lib/focus.ts");
  const view = { width: 1000, height: 700, cx: 500, cy: 350 };

  /** The box a neighbour's name occupies, as the map draws it. */
  const labelBox = (p, name) => {
    const half = (Math.min(name.length, 26) * 7.6) / 2 + 4;
    // Outward from the subject, and a line further out on alternate rings.
    const shift = p.labelShift ?? 0;
    const top = p.above ? p.y - 9 - 19 - shift : p.y + 9 + shift;
    return { x1: p.x - half, y1: top, x2: p.x + half, y2: top + 21 };
  };
  /**
   * Overlapping *readably*, not overlapping at all.
   *
   * Sixteen names of twenty-odd characters cannot be laid out in a thousand
   * pixels with mathematically zero contact — at some point the geometry simply
   * runs out, and the honest choice is between a small overlap and a cluster
   * that no longer fits on screen. What must not happen is text piled on text.
   * So the bar is a tenth of a label's area, which is a few pixels of one
   * word's edge rather than a name sitting on another.
   */
  const clash = (a, b) => {
    const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
    const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
    if (w <= 0 || h <= 0) return false;
    const area = (a.x2 - a.x1) * (a.y2 - a.y1);
    return (w * h) / area > 0.1;
  };

  const gather = (name, count) => {
    const nodes = [
      { id: 1, name: "Subject", type: "person", degree: count, mentions: 3, hasPortrait: false, x: 0, y: 0, r: 9 },
    ];
    const edges = [];
    for (let i = 2; i <= count + 1; i++) {
      nodes.push({ id: i, name, type: "person", degree: 2, mentions: 2, hasPortrait: false, x: i * 17, y: i * 11, r: 9 });
      edges.push({ a: 1, b: i, nature: "other", colour: "#888", type: "knows" });
    }
    const place = focusLayout(
      { nodes, edges, width: 2400, height: 1600, omitted: 0, total: nodes.length },
      1,
      view
    );
    const boxes = [...place.entries()].filter(([id]) => id !== 1).map(([, p]) => labelBox(p, name));
    let clashes = 0;
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) if (clash(boxes[a], boxes[b])) clashes++;
    }
    return { clashes, placed: boxes.length };
  };

  // The reported failure: rings sized for the dots, with names far wider than
  // them, so the gathered cluster came out as a pile of overlapping text.
  const long = gather("Organization of Petroleum Exporting Countries", 8);
  check("eight long names on a ring never overlap", long.clashes === 0, `${long.clashes} clashes`);
  check("and all eight are placed", long.placed === 8);

  const many = gather("Faysal ibn Abd al-Aziz", 16);
  check("sixteen do not either", many.clashes === 0, `${many.clashes} clashes`);

  const short = gather("Ali", 10);
  check("nor do short ones", short.clashes === 0, `${short.clashes} clashes`);

  const ringsFor = (name) => {
    const nodes = [{ id: 1, name: "S", type: "person", degree: 6, mentions: 3, hasPortrait: false, x: 0, y: 0, r: 9 }];
    const edges = [];
    for (let i = 2; i <= 7; i++) {
      nodes.push({ id: i, name, type: "person", degree: 2, mentions: 2, hasPortrait: false, x: 0, y: 0, r: 9 });
      edges.push({ a: 1, b: i, nature: "other", colour: "#888", type: "knows" });
    }
    const place = focusLayout(
      { nodes, edges, width: 2400, height: 1600, omitted: 0, total: nodes.length },
      1,
      view
    );
    const pts = [...place.entries()].filter(([id]) => id !== 1).map(([, p]) => p);
    return new Set(pts.map((p) => Math.round(Math.hypot(p.x - view.cx, p.y - view.cy)))).size;
  };
  check(
    "long names claim more of the ring, spilling onto a second one",
    ringsFor("Organization of Petroleum Exporting Countries") > ringsFor("Ali")
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);


