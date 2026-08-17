"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { EntityType } from "@/lib/types";
import { NATURES, natureOf, type Nature } from "@/lib/relations";
import {
  LABEL_SIZE,
  C,
  VIEW,
  clip,
  familyTree,
  layout,
  type Connection,
  type NetworkTie,
  type TreeBox,
} from "@/lib/graph";

export type { Connection } from "@/lib/graph";

/**
 * One picture of a life.
 *
 * Earlier versions listed connections in tidy boxes, which answered "who" but
 * never "what kind of person is this" — and that second question is the whole
 * reason to draw anything. So: neighbours on a ring, grouped into coloured arcs
 * by the nature of the tie, sized by how much the library has on them, joined
 * to each other by chords across the middle. The proportions of the ring are
 * the argument; the names are the footnotes.
 *
 * Family is drawn separately, as an actual tree. Generations are a different
 * geometry, and a ring either loses them or invents them.
 */
export function ConnectionsGraph({
  centreName,
  centreType,
  connections,
  network = [],
  pictured = [],
}: {
  centreName: string;
  centreType: EntityType;
  connections: Connection[];
  network?: NetworkTie[];
  /** Which neighbours have a picture, read once on the server. */
  pictured?: number[];
}) {
  const uid = useId().replace(/:/g, "");
  const faces = useMemo(() => new Set(pictured), [pictured]);
  const router = useRouter();
  const [focus, setFocus] = useState<Nature | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [webOnly, setWebOnly] = useState(false);

  const visible = useMemo(
    () => (focus ? connections.filter((c) => natureOf(c.type).id === focus) : connections),
    [connections, focus]
  );

  // Filtering re-runs the layout rather than hiding nodes, so a focused view
  // uses the whole circle instead of leaving nine-tenths of it empty.
  const g = useMemo(() => layout(visible, network), [visible, network]);
  const all = useMemo(() => layout(connections, network), [connections, network]);
  const tree = useMemo(() => familyTree(connections, centreName), [connections, centreName]);

  const linked = useMemo(() => {
    if (hovered === null) return new Set<number>();
    const s = new Set<number>();
    for (const c of g.chords) {
      if (c.a === hovered) s.add(c.b);
      if (c.b === hovered) s.add(c.a);
    }
    return s;
  }, [g.chords, hovered]);

  const active = g.nodes.find((n) => n.entityId === hovered);
  const activeChords = g.chords.filter((c) => c.a === hovered || c.b === hovered);
  const nameOf = (id: number) => g.nodes.find((n) => n.entityId === id)?.name ?? "someone";

  if (connections.length === 0) return null;

  const dimmed = (id: number) => hovered !== null && hovered !== id && !linked.has(id);
  const chordsShown = webOnly || hovered !== null;
  // Someone known only through their family gets the tree and nothing else —
  // an empty ring with no arcs on it says nothing at all.
  const ring = all.total > 0;

  return (
    <div className="space-y-3">
      {ring && <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setFocus(null)}
          className={`rounded-full px-3 py-1 text-xs transition ${
            focus === null
              ? "bg-[var(--color-ink)] text-white"
              : "border border-[var(--color-rule)] bg-white hover:bg-[var(--color-accent-soft)]"
          }`}
        >
          Everything {all.total}
        </button>
        {all.bands.map((b) => (
          <button
            key={b.nature}
            title={b.note}
            onClick={() => setFocus(focus === b.nature ? null : b.nature)}
            className="rounded-full px-3 py-1 text-xs transition"
            style={
              focus === b.nature
                ? { background: b.colour, color: "white" }
                : { border: `1px solid ${b.colour}`, color: b.colour }
            }
          >
            {b.label}
            <span className="ml-1.5 opacity-60">{b.count}</span>
          </button>
        ))}

        {all.chords.length > 0 && (
          <button
            onClick={() => setWebOnly((v) => !v)}
            title="Ties between these neighbours, rather than between them and the centre"
            className={`ml-auto rounded-full px-3 py-1 text-xs transition ${
              webOnly
                ? "bg-[var(--color-ink)] text-white"
                : "border border-[var(--color-rule)] bg-white hover:bg-[var(--color-accent-soft)]"
            }`}
          >
            Ties among them
            <span className="ml-1.5 opacity-60">{all.chords.length}</span>
          </button>
        )}
      </div>}

      {ring && <div className="rounded-lg border border-[var(--color-rule)] bg-white p-1">
        <svg
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          className="mx-auto block h-auto w-full"
          role="img"
          aria-label={`Connections of ${centreName}`}
          onMouseLeave={() => setHovered(null)}
        >
          <defs>
            {g.bands.map((b) => (
              <path key={b.nature} id={`${uid}-band-${b.nature}`} d={b.labelPath} fill="none" />
            ))}
          </defs>

          {/* Ties between the neighbours themselves: the web behind the star. */}
          <g fill="none" strokeLinecap="round">
            {g.chords.map((c) => {
              const on = hovered === c.a || hovered === c.b;
              return (
                <path
                  key={c.id}
                  d={c.path}
                  stroke={c.colour}
                  strokeWidth={on ? 2.6 : chordsShown ? 1.8 : 1.4}
                  opacity={hovered === null ? (webOnly ? 0.7 : 0.3) : on ? 0.9 : 0.05}
                />
              );
            })}
          </g>

          {/* Spokes, bundled by nature so groups leave the hub as one stroke. */}
          <g fill="none" strokeLinecap="round">
            {g.nodes.map((n) => (
              <path
                key={n.entityId}
                d={n.spoke}
                stroke={n.colour}
                strokeWidth={Math.min(1.4 + n.strength * 0.9, 4.5)}
                opacity={
                  dimmed(n.entityId) ? 0.06 : hovered === n.entityId ? 0.95 : webOnly ? 0.12 : 0.34
                }
              />
            ))}
          </g>

          {/* Nature bands: the part you are meant to read first. */}
          <g>
            {g.bands.map((b) => (
              <g
                key={b.nature}
                className="cursor-pointer"
                onClick={() => setFocus(focus === b.nature ? null : b.nature)}
              >
                <path d={b.arc} fill={b.colour} opacity={0.85} />
                <text
                  fill={b.colour}
                  fontSize={20}
                  fontWeight={500}
                  letterSpacing="0.04em"
                  dominantBaseline={b.flipped ? "hanging" : "auto"}
                >
                  <textPath href={`#${uid}-band-${b.nature}`} startOffset="50%" textAnchor="middle">
                    {b.label}
                  </textPath>
                </text>
              </g>
            ))}
          </g>

          {/* The hub. Drawn over the chords, which read as passing behind it. */}
          <circle cx={C} cy={C} r={58} fill="white" />
          <circle
            cx={C}
            cy={C}
            r={44}
            fill="var(--color-accent-soft)"
            stroke="var(--color-accent)"
            strokeWidth={1.5}
          />
          <text
            x={C}
            y={C}
            textAnchor="middle"
            fontSize={17}
            fontWeight={600}
            fill="var(--color-ink)"
            style={{ paintOrder: "stroke", stroke: "white", strokeWidth: 5 }}
          >
            {twoLines(centreName).map((line, i, arr) => (
              <tspan key={i} x={C} dy={i === 0 ? (arr.length === 1 ? 6 : -2) : 18}>
                {line}
              </tspan>
            ))}
          </text>

          {/* Neighbours. */}
          <g>
            {g.nodes.map((n) => {
              const dim = dimmed(n.entityId);
              return (
                <g
                  key={n.entityId}
                  className="cursor-pointer"
                  onMouseEnter={() => setHovered(n.entityId)}
                  onFocus={() => setHovered(n.entityId)}
                  onClick={() => router.push(`/pedia/${n.entityId}`)}
                  onKeyDown={(e) => e.key === "Enter" && router.push(`/pedia/${n.entityId}`)}
                  tabIndex={0}
                  role="link"
                  opacity={dim ? 0.22 : 1}
                >
                  <title>{`${n.name} — ${n.relations.map((r) => r.type).join(", ")}`}</title>
                  {/* A small disc is a cruel thing to ask a mouse to hit, so the
                      target is bigger than the mark that shows. */}
                  <circle cx={n.x} cy={n.y} r={Math.max(n.r + 8, 15)} fill="transparent" />
                  <Mark n={n} lit={hovered === n.entityId} pictured={faces.has(n.entityId)} />
                  <text
                    transform={n.labelTransform}
                    textAnchor={n.labelAnchor}
                    dominantBaseline="middle"
                    fontSize={LABEL_SIZE}
                    fontWeight={hovered === n.entityId ? 700 : 400}
                    fill={hovered === n.entityId ? n.colour : "var(--color-ink)"}
                    style={{ paintOrder: "stroke", stroke: "white", strokeWidth: 4 }}
                  >
                    {n.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>}

      {ring && <div className="min-h-[5rem] rounded-lg border border-[var(--color-rule)] bg-white p-3 text-sm">
        {active ? (
          <div>
            <p className="font-medium">
              {centreName}{" "}
              <span className="text-[var(--color-muted)]">
                {active.relations
                  .map((r) => (r.direction === "out" ? r.type : `← ${r.type}`))
                  .join(", ")}
              </span>{" "}
              <Link href={`/pedia/${active.entityId}`} className="hover:text-[var(--color-accent)]">
                {active.name}
              </Link>
            </p>
            {active.relations.find((r) => r.quote) && (
              <p className="mt-1 border-l-2 border-[var(--color-rule)] pl-3 text-[var(--color-muted)]">
                “{active.relations.find((r) => r.quote)!.quote}”
              </p>
            )}
            {activeChords.length > 0 && (
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Also tied to{" "}
                {activeChords
                  .slice(0, 4)
                  .map((c) => `${nameOf(c.a === active.entityId ? c.b : c.a)} (${c.type})`)
                  .join(", ")}
                {activeChords.length > 4 ? ` and ${activeChords.length - 4} more` : ""} — the
                highlighted lines.
              </p>
            )}
          </div>
        ) : (
          <p className="text-[var(--color-muted)]">
            Arcs are kinds of tie, and their width is how much of the record each one is. Discs are
            people, squares organisations, diamonds places and events; size is how often the library
            mentions them, spoke thickness how many times a tie is documented. Lines across the
            middle are ties the sources record <em>between</em> these neighbours. Hover a name for
            what the sources say; click to open it.
          </p>
        )}
      </div>}

      {g.hidden > 0 && (
        <p className="text-xs text-[var(--color-muted)]">
          Showing the {g.nodes.length} best-documented of {g.total}. Narrow with a kind above, or
          read the full list below.
        </p>
      )}

      {tree && <FamilyTree tree={tree} hovered={hovered} onHover={setHovered} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Mark({
  n,
  lit,
  pictured,
}: {
  n: ReturnType<typeof layout>["nodes"][number];
  lit: boolean;
  pictured: boolean;
}) {
  // A face where there is one. The mark keeps its coloured ring, so the nature
  // of the tie is still readable at a glance — the picture says who, the ring
  // still says what kind of tie.
  if (pictured) {
    return (
      <>
        <clipPath id={`node-clip-${n.entityId}`}>
          <circle cx={n.x} cy={n.y} r={n.r} />
        </clipPath>
        <image
          href={`/api/entities/${n.entityId}/portrait`}
          x={n.x - n.r}
          y={n.y - n.r}
          width={n.r * 2}
          height={n.r * 2}
          clipPath={`url(#node-clip-${n.entityId})`}
          preserveAspectRatio="xMidYMid slice"
        />
        <circle
          cx={n.x}
          cy={n.y}
          r={n.r}
          fill="none"
          stroke={n.colour}
          strokeWidth={lit ? 3 : 2.2}
        />
      </>
    );
  }

  const common = { fill: lit ? n.colour : "white", stroke: n.colour, strokeWidth: 2.2 };
  if (n.shape === "square") {
    const s = n.r * 1.75;
    return <rect x={n.x - s / 2} y={n.y - s / 2} width={s} height={s} rx={1.5} {...common} />;
  }
  if (n.shape === "diamond") {
    const s = n.r * 1.15;
    return (
      <path
        d={`M ${n.x} ${n.y - s} L ${n.x + s} ${n.y} L ${n.x} ${n.y + s} L ${n.x - s} ${n.y} Z`}
        {...common}
      />
    );
  }
  return <circle cx={n.x} cy={n.y} r={n.r} {...common} />;
}

/** Two lines at most, broken on a word boundary — a hub, not a paragraph. */
function twoLines(name: string): string[] {
  const words = name.split(/\s+/);
  if (name.length <= 12 || words.length === 1) return [clip(name, 13)];
  let best = 1;
  for (let i = 1; i < words.length; i++) {
    const gap = (k: number) =>
      Math.abs(words.slice(0, k).join(" ").length - words.slice(k).join(" ").length);
    if (gap(i) < gap(best)) best = i;
  }
  return [clip(words.slice(0, best).join(" "), 13), clip(words.slice(best).join(" "), 13)];
}

/**
 * Family as a pedigree chart: generations in rows joined by square connectors.
 * Placed outside the circle rather than inside it, because descent is the one
 * relation with a real up and down and a ring cannot show one.
 */
function FamilyTree({
  tree,
  hovered,
  onHover,
}: {
  tree: NonNullable<ReturnType<typeof familyTree>>;
  hovered: number | null;
  onHover: (id: number | null) => void;
}) {
  const router = useRouter();

  return (
    <section className="rounded-lg border border-[var(--color-rule)] bg-white p-4">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ background: NATURES.kin.colour }}
          aria-hidden
        />
        <h3 className="text-sm font-medium">Family</h3>
        <span className="text-xs text-[var(--color-muted)]">
          Rows are generations, where the sources say so outright. Each label says what that person
          is to {tree.boxes.find((b) => b.self)?.name ?? "this entity"}; hover for the source&rsquo;s
          own wording.
        </span>
      </div>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${tree.width} ${tree.height}`}
          className="mx-auto block h-auto max-w-full"
          // A four-box tree drawn at its natural size looks lost on a wide page,
          // so small trees are enlarged and big ones held back to a readable
          // width rather than every tree rendering at the same scale.
          style={{ width: Math.min(Math.max(tree.width * 1.35, 480), 940) }}
          role="img"
          aria-label="Family tree"
        >
          {/* Square for descent, curved for ties within a generation — the two
              mean different things and should not look alike. */}
          <g fill="none" stroke={NATURES.kin.colour} strokeWidth={1.4} opacity={0.65}>
            {tree.links.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </g>
          <g
            fill="none"
            stroke={NATURES.kin.colour}
            strokeWidth={1.3}
            strokeDasharray="5 4"
            opacity={0.55}
          >
            {tree.arcs.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </g>
          {tree.boxes.map((b) => (
            <Person
              key={b.self ? "self" : b.entityId}
              b={b}
              lit={hovered === b.entityId}
              onHover={onHover}
              onOpen={() => !b.self && router.push(`/pedia/${b.entityId}`)}
            />
          ))}
        </svg>
      </div>
    </section>
  );
}

function Person({
  b,
  lit,
  onHover,
  onOpen,
}: {
  b: TreeBox;
  lit: boolean;
  onHover: (id: number | null) => void;
  onOpen: () => void;
}) {
  const kin = NATURES.kin.colour;
  return (
    <g
      className={b.self ? undefined : "cursor-pointer"}
      onMouseEnter={() => !b.self && onHover(b.entityId)}
      onMouseLeave={() => onHover(null)}
      onClick={onOpen}
      tabIndex={b.self ? undefined : 0}
      role={b.self ? undefined : "link"}
    >
      {/* The source's own wording survives here, in full and undirected. */}
      {!b.self && <title>{`${b.name} — ${b.relations.map((r) => r.type).join(", ")}`}</title>}
      <rect
        x={b.x}
        y={b.y}
        width={b.w}
        height={b.h}
        rx={6}
        fill={b.self ? "var(--color-accent-soft)" : lit ? `${kin}1f` : "white"}
        stroke={b.self ? "var(--color-accent)" : kin}
        strokeWidth={b.self ? 1.8 : 1.3}
      />
      <text
        x={b.x + b.w / 2}
        y={b.y + b.h / 2}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={14}
        fontWeight={b.self ? 600 : 400}
        fill="var(--color-ink)"
      >
        {b.label}
      </text>
      {/* What this person is to the subject, not what the subject is to them:
          printing the stored wording here captioned a father "is the son of". */}
      {!b.self && (
        <text
          x={b.x + b.w / 2}
          y={b.captionAbove ? b.y - 9 : b.y + b.h + 15}
          textAnchor="middle"
          fontSize={12}
          fill="var(--color-muted)"
        >
          {b.role ?? clip(b.relations[0].type, 22)}
        </text>
      )}
    </g>
  );
}
