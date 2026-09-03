/**
 * The connections diagram's arithmetic.
 *
 * The drawing is only useful if it is stable — the same person has to look the
 * same every time, or you cannot use the shape as a memory of them. That means
 * the layout has to be deterministic and the paths have to be well formed, and
 * neither is something you can eyeball on a 70-node ring.
 *
 *   npx tsx scripts/test-graph.mjs
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

const {
  layout, familyTree, clip, dominantNature, point,
  MAX_NODES, MAX_LABEL, MAX_R, CHAR_W, VIEW, C, RING, BAND,
} = await import("../lib/graph.ts");
const { natureOf, kinRole } = await import("../lib/relations.ts");

// ---------------------------------------------------------------------------
section("A family tree labels the other end of the tie, so the wording inverts");
// ---------------------------------------------------------------------------
// The bug this guards: the stored phrase was printed beside the other person,
// which captioned Netanyahu's father "is the son of".
const role = (type, dir, want) =>
  check(`"${type}" (${dir}) makes them ${want}`, kinRole(type, dir) === want, `${kinRole(type, dir)}`);

role("is the son of", "out", "parent");
role("is the son of", "in", "child");
role("father of", "out", "child");
role("father of", "in", "parent");
role("daughter of", "out", "parent");
role("mother of", "out", "child");
role("married to", "out", "spouse");
role("married to", "in", "spouse");
role("younger brother of", "out", "sibling");
role("brother of", "in", "sibling");
role("grandson of", "out", "grandparent");
role("grandfather of", "out", "grandchild");
role("cousin of", "out", "cousin");
role("descendant of", "out", "ancestor");
check("a compound is not read as the word inside it", kinRole("grandson of", "out") !== "parent");
check("an unknown phrasing says nothing rather than guessing",
  kinRole("was close to", "out") === null);
check("inverses are gender-neutral", kinRole("is the son of", "out") === "parent");

// ---------------------------------------------------------------------------
section("Sources write in the past tense, so stems have to take endings");
// ---------------------------------------------------------------------------
// The bug this guards: `\b(oppos)\b` requires the word to *end* at the stem, so
// every inflected phrasing fell through to Other. It was 56% of a real library.
const nature = (phrase, want) =>
  check(`"${phrase}" is ${want}`, natureOf(phrase).id === want, natureOf(phrase).id);

nature("opposed", "conflict");
nature("assassinated", "conflict");
nature("condemned", "conflict");
nature("authored", "authorship");
nature("co-authored with", "authorship");
nature("advised", "office");
nature("headed", "office");
nature("employed", "office");
nature("allied with", "political");
nature("supported", "political");
nature("lobbied", "political");
nature("influenced", "political");
nature("invested in", "ownership");
nature("established", "ownership");
nature("declared establishment of", "ownership");
nature("donated to", "ownership");
nature("affiliated with", "membership");
nature("represented", "membership");
nature("worked at", "office");
nature("worked with", "office");
nature("served", "office");
nature("has diplomatic relations with", "political");
nature("has operations in", "place");

section("…and \"from\" on its own is not geography");
// A bare "from" stem put "took orders from" and "learned Arabic from" in the
// place cluster of the connections graph. Only explicit place verbs count.
nature("took orders from", "other");
nature("learned Arabic from", "other");
nature("born in", "place");
nature("was based in", "place");
nature("moved to", "place");
nature("lived in", "place");
nature("located in", "place");
nature("travelled to", "place");
nature("traveled to", "place");
nature("travelled with", "contact");
nature("visited", "contact");

section("…without inventing kin out of anything ending in a vowel");
nature("Sony", "other");
nature("sonar contract", "ownership");
nature("compared to", "other");
check('"sons of" is still kin', natureOf("sons of").id === "kin");
check('"children of" is still kin', natureOf("children of").id === "kin");
check(
  "the classifier leaves a genuine one-off alone",
  natureOf("conceptually defined").id === "other"
);

let nextId = 1;
const rel = (name, type, opts = {}) => ({
  id: nextId++,
  type,
  quote: opts.quote ?? null,
  direction: opts.direction ?? "out",
  other_id: opts.otherId ?? nextId * 1000,
  other_name: name,
  other_type: opts.otherType ?? "person",
  other_weight: opts.weight ?? 1,
});

// ---------------------------------------------------------------------------
section("A tie lands in the group that explains the most");
// ---------------------------------------------------------------------------
check("kin beats employment", dominantNature([rel("A", "worked for"), rel("A", "brother of")]).id === "kin");
check(
  "founding beats a meeting",
  dominantNature([rel("A", "met with"), rel("A", "founded")]).id === "ownership"
);
check(
  "anything beats nothing",
  dominantNature([rel("A", "associated with"), rel("A", "opposed")]).id === "conflict"
);
check("a lone unclassifiable tie is Other", dominantNature([rel("A", "associated with")]).id === "other");

// ---------------------------------------------------------------------------
section("One node per neighbour, however many ties");
// ---------------------------------------------------------------------------
{
  const g = layout(
    [
      rel("Ivana", "married", { otherId: 7 }),
      rel("Ivana", "co-owned", { otherId: 7 }),
      rel("Roy Cohn", "advised by", { otherId: 8 }),
    ],
    [],
    { withKin: true }
  );
  check("three relations, two nodes", g.nodes.length === 2, `${g.nodes.length}`);
  const ivana = g.nodes.find((n) => n.entityId === 7);
  check("both her ties are carried", ivana.relations.length === 2);
  check("the more explanatory tie sets her group", ivana.nature === "kin", ivana.nature);
  check("spoke weight follows how often it is documented", ivana.strength === 2);
}

// ---------------------------------------------------------------------------
section("Everything stays inside the canvas");
// ---------------------------------------------------------------------------
{
  const many = [];
  for (let i = 0; i < 40; i++) {
    const types = ["married", "founded", "served under", "opposed", "met with", "member of"];
    many.push(
      rel(`Person ${i}`, types[i % types.length], { otherId: i + 1, weight: (i % 9) + 1 })
    );
  }
  const g = layout(many, [], { withKin: true });
  check("every neighbour placed", g.nodes.length === 40);
  check(
    "nodes sit on the ring",
    g.nodes.every((n) => Math.abs(Math.hypot(n.x - C, n.y - C) - RING) < 0.05)
  );
  check(
    "nodes are inside the viewBox",
    g.nodes.every((n) => n.x > 0 && n.y > 0 && n.x < VIEW && n.y < VIEW)
  );
  check("the band is inside the viewBox", BAND + 30 < VIEW / 2 + 5, `${BAND}`);
  check(
    "no two nodes share an angle",
    new Set(g.nodes.map((n) => n.angle.toFixed(6))).size === g.nodes.length
  );

  // Arcs must tile the circle in order without overlapping.
  const spans = g.bands.map((b) => [b.from, b.to]);
  check(
    "arcs run clockwise and never overlap",
    spans.every(([from, to], i) => to > from && (i === 0 || from > spans[i - 1][1]))
  );
  check("arcs fit in one turn", spans[spans.length - 1][1] - spans[0][0] < Math.PI * 2);
  check(
    "an arc is as wide as its share",
    (() => {
      const widest = [...g.bands].sort((a, b) => b.count - a.count)[0];
      const narrowest = [...g.bands].sort((a, b) => a.count - b.count)[0];
      return widest.to - widest.from >= narrowest.to - narrowest.from;
    })()
  );
  check(
    "every path is well formed",
    g.nodes.every((n) => /^M [\d.]+ [\d.]+ C( [\d.-]+){6}$/.test(n.spoke)) &&
      g.bands.every((b) => b.arc.startsWith("M ") && b.arc.endsWith("Z") && !b.arc.includes("NaN"))
  );
  check("labels are anchored away from the circle", g.nodes.every((n) =>
    n.x < C ? n.labelAnchor === "end" : n.labelAnchor === "start"
  ));
}

// ---------------------------------------------------------------------------
section("The same input always draws the same picture");
// ---------------------------------------------------------------------------
{
  const input = [
    rel("Zed", "opposed", { otherId: 3, weight: 4 }),
    rel("Amy", "founded", { otherId: 1, weight: 9 }),
    rel("Mid", "married", { otherId: 2, weight: 4 }),
  ];
  const a = JSON.stringify(layout(input, [], { withKin: true }));
  const b = JSON.stringify(layout([...input].reverse(), [], { withKin: true }));
  check("order of the rows does not move anything", a === b);

  const g = layout(input, [], { withKin: true });
  check("heaviest neighbour is the biggest mark", (() => {
    const amy = g.nodes.find((n) => n.entityId === 1);
    return g.nodes.every((n) => n.r <= amy.r + 0.001);
  })());
  check(
    "equal weights draw equal marks",
    Math.abs(g.nodes.find((n) => n.entityId === 2).r - g.nodes.find((n) => n.entityId === 3).r) < 0.001
  );
}

// ---------------------------------------------------------------------------
section("Chords join neighbours to each other");
// ---------------------------------------------------------------------------
{
  const conns = [
    rel("Jared", "advised by", { otherId: 10 }),
    rel("Ivanka", "daughter of", { otherId: 11 }),
    rel("Nobody", "met with", { otherId: 12 }),
  ];
  const net = [
    { id: 1, type: "married", quote: "q", a: 10, b: 11 },
    { id: 2, type: "married", quote: "q", a: 11, b: 10 },
    { id: 3, type: "sued", quote: null, a: 10, b: 99 },
  ];
  const g = layout(conns, net, { withKin: true });
  check("the same tie is not drawn twice", g.chords.length === 1, `${g.chords.length}`);
  check("a tie to someone off the ring is dropped", !g.chords.some((c) => c.b === 99 || c.a === 99));
  check("a chord takes the colour of its own nature", g.chords[0].colour === "#a8536b");
  check("chord path is well formed", /^M [\d.]+ [\d.]+ Q( [\d.-]+){4}$/.test(g.chords[0].path));
  check(
    "the bow stays inside the ring",
    (() => {
      const [, , , qx, qy] = g.chords[0].path.split(/[ Q]+/).map(Number);
      return Math.hypot(qx - C, qy - C) <= RING;
    })()
  );
}
{
  // Two neighbours either side of the top of the circle: the bisector must not
  // flip to the bottom and sling the chord around the outside.
  const g = layout(
    [
      rel("A", "founded", { otherId: 1 }),
      rel("B", "founded", { otherId: 2 }),
      rel("C", "founded", { otherId: 3 }),
      rel("D", "founded", { otherId: 4 }),
    ],
    [{ id: 1, type: "sued", quote: null, a: 1, b: 4 }]
  );
  const [, , , qx, qy] = g.chords[0].path.split(/[ Q]+/).map(Number);
  const a = g.nodes.find((n) => n.entityId === 1);
  const d = g.nodes.find((n) => n.entityId === 4);
  check(
    "the bow bends toward the near side, not the far one",
    Math.hypot(qx - (a.x + d.x) / 2, qy - (a.y + d.y) / 2) < RING,
    `${qx},${qy}`
  );
}

// ---------------------------------------------------------------------------
section("A crowded ring folds rather than turning into a hairball");
// ---------------------------------------------------------------------------
{
  const many = [];
  for (let i = 0; i < 120; i++) {
    many.push(rel(`P${i}`, "met with", { otherId: i + 1, weight: i }));
  }
  const g = layout(many);
  check("the ring is capped", g.nodes.length === MAX_NODES, `${g.nodes.length}`);
  check("the count is honest about it", g.total === 120 && g.hidden === 120 - MAX_NODES);
  check(
    "it keeps the best-documented",
    g.nodes.every((n) => n.weight >= 120 - MAX_NODES - 1)
  );
}

// ---------------------------------------------------------------------------
section("Long names are clipped, not overlapped");
// ---------------------------------------------------------------------------
check("a short name is untouched", clip("Donald Trump") === "Donald Trump");
check(
  "a long one is cut to fit",
  clip("The Trump Organization LLC of New York").length === MAX_LABEL
);
check("the cut lands on the ellipsis", clip("The Trump Organization LLC of New York").endsWith("…"));
check(
  "a name is never cut mid-space",
  !/\s…$/.test(clip("Committee for the Liberation of Somewhere Or Other"))
);
// The failure this pins: the longest label an all-caps name can produce must
// still stop short of the nature band, or names run straight through it.
{
  const start = RING + MAX_R + 9;
  const longest = start + MAX_LABEL * CHAR_W;
  check("the longest label clears the band", longest < BAND, `${longest.toFixed(0)} vs ${BAND}`);
  check("and the band clears the canvas", BAND + 30 < VIEW / 2, `${BAND + 30} vs ${VIEW / 2}`);
  check("there is still room for a real name", MAX_LABEL >= 24, `${MAX_LABEL}`);
}

// ---------------------------------------------------------------------------
section("Empty and single cases do not throw");
// ---------------------------------------------------------------------------
{
  const empty = layout([]);
  check("nothing in, nothing out", empty.nodes.length === 0 && empty.bands.length === 0);
  const one = layout([rel("Only", "married", { otherId: 1 })], [], { withKin: true });
  check("a single neighbour gets the whole circle", one.bands[0].to - one.bands[0].from > 6);
  check("and is still on the ring", Math.abs(Math.hypot(one.nodes[0].x - C, one.nodes[0].y - C) - RING) < 0.05);
  const [px, py] = point(0, 100);
  check("the point helper measures from the centre", px === C + 100 && py === C);
}

// ---------------------------------------------------------------------------
section("Arc labels are never upside down");
// ---------------------------------------------------------------------------
{
  // One neighbour per nature spreads arcs all the way round the circle, so
  // every quadrant gets tested at once. The bug this guards: flipping was keyed
  // on left-versus-right, which stood the top-left arcs on their heads.
  const round = [
    rel("A", "founded", { otherId: 1 }),
    rel("B", "served under", { otherId: 2 }),
    rel("C", "member of", { otherId: 3 }),
    rel("D", "allied with", { otherId: 4 }),
    rel("E", "opposed", { otherId: 5 }),
    rel("F", "wrote", { otherId: 6 }),
    rel("G", "met with", { otherId: 7 }),
    rel("H", "born in", { otherId: 8 }),
    rel("I", "conceptually defined", { otherId: 9 }),
  ];
  const g = layout(round);
  check("arcs reach right round the circle", g.bands.length === 9, `${g.bands.length}`);
  check(
    "an arc is flipped exactly when it sits below the centre",
    g.bands.every((b) => b.flipped === Math.sin((b.from + b.to) / 2) > 0)
  );
  check(
    "a flipped label runs anticlockwise, an upright one clockwise",
    g.bands.every((b) => {
      const sweep = b.labelPath.trim().split(/\s+/).slice(-3)[0];
      return b.flipped ? sweep === "0" : sweep === "1";
    })
  );
  check(
    "label paths sit outside the band",
    g.bands.every((b) => !b.labelPath.includes("NaN"))
  );
}

// ---------------------------------------------------------------------------
section("Family is a tree, and is kept out of the ring");
// ---------------------------------------------------------------------------
{
  const kin = [
    rel("Fred Trump", "father of", { otherId: 1, direction: "in" }),
    rel("Ivana", "married", { otherId: 2 }),
    rel("Ivanka", "daughter of", { otherId: 3, direction: "in" }),
    rel("Eric", "son of", { otherId: 4, direction: "in" }),
    rel("Roy Cohn", "advised by", { otherId: 5 }),
  ];
  const g = layout(kin);
  check("relatives are off the ring", g.nodes.length === 1 && g.nodes[0].entityId === 5);
  check("and back on it when asked for", layout(kin, [], { withKin: true }).nodes.length === 5);

  const t = familyTree(kin, "Donald Trump");
  check("the tree has every relative plus the subject", t.boxes.length === 5, `${t.boxes.length}`);
  check("exactly one box is the subject", t.boxes.filter((b) => b.self).length === 1);
  check("the adviser is not in the family tree", !t.boxes.some((b) => b.entityId === 5));

  const rowOf = (name) => t.boxes.find((b) => b.name === name)?.y;
  const self = t.boxes.find((b) => b.self);
  check("a parent sits above the subject", rowOf("Fred Trump") < self.y, `${rowOf("Fred Trump")}`);
  check("children sit below", rowOf("Ivanka") > self.y && rowOf("Eric") > self.y);
  check("a spouse sits alongside", rowOf("Ivana") === self.y);
  check("children share a row", rowOf("Ivanka") === rowOf("Eric"));
  check(
    "no two boxes overlap",
    t.boxes.every((a, i) =>
      t.boxes.every(
        (b, j) => i === j || a.y !== b.y || a.x + a.w <= b.x || b.x + b.w <= a.x
      )
    )
  );
  check(
    "everything fits the canvas",
    t.boxes.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= t.width && b.y + b.h <= t.height)
  );
  check("there are connectors", t.links.length > 0 && t.links.every((d) => !d.includes("NaN")));

  // The mangling that prompted all this: same-row relatives were joined by
  // straight lines along the row, which ran through whatever sat between them.
  check("same-row ties are curves, not lines through the row", t.arcs.length === 1);
  check("a curve runs from the subject to the relative", t.arcs.every((d) => d.startsWith("M ") && d.includes(" Q ")));
  check(
    "no descent connector crosses a box",
    t.links.every((d) => {
      const [x1, y1, x2, y2] = d.match(/-?[\d.]+/g).map(Number);
      return t.boxes.every((b) => {
        const horizontal = y1 === y2;
        if (horizontal) return y1 <= b.y || y1 >= b.y + b.h;
        // A vertical drop may touch its own box's edge but not pass through it.
        return x1 <= b.x || x1 >= b.x + b.w || Math.max(y1, y2) <= b.y || Math.min(y1, y2) >= b.y + b.h;
      });
    })
  );

  check("the subject is captioned by nothing", self.role === null);
  check("a parent is captioned as a parent", t.boxes.find((b) => b.name === "Fred Trump").role === "parent");
  check("a child is captioned as a child", t.boxes.find((b) => b.name === "Ivanka").role === "child");
  check("a spouse is captioned as a spouse", t.boxes.find((b) => b.name === "Ivana").role === "spouse");
  check(
    "captions face away from the connectors",
    t.boxes.filter((b) => b.generation === 1).every((b) => !b.captionAbove) &&
      t.boxes.filter((b) => b.generation <= 0).every((b) => b.captionAbove)
  );

  check("no kin, no tree", familyTree([rel("X", "advised by", { otherId: 9 })], "Y") === null);

  // A subject with only children must not leave an empty band of whitespace.
  const down = familyTree([rel("Kid", "son of", { otherId: 1, direction: "in" })], "Parent");
  check("an absent generation costs no height", down.height < t.height, `${down.height}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
