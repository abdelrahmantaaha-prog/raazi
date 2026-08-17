import Link from "next/link";
import { buildNetwork, starfield } from "@/lib/network";
import { NetworkMap } from "./NetworkMap";
import { listTags } from "@/lib/tags";
import { NATURES, type Nature } from "@/lib/relations";
import { Empty } from "../components/ui";

export const dynamic = "force-dynamic";

/**
 * Every connection in the library, on one canvas.
 *
 * The per-entity diagram shows a life; this shows a body of research. What it
 * is for is noticing things you did not put there — that two subjects you
 * thought were separate share a cluster, or that a name you have been treating
 * as marginal is holding two halves of your material together.
 *
 * Laid out by a force simulation on the server, so the picture is fixed and
 * reproducible; the browser only handles hovering.
 */
export default async function NetworkPage({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string; nature?: string; degree?: string }>;
}) {
  const params = await searchParams;
  const tagId = Number(params.tag ?? 0) || undefined;
  const nature = (params.nature as Nature) || undefined;
  const minDegree = Math.max(1, Math.min(8, Number(params.degree ?? 3) || 3));

  const net = buildNetwork({ tagId, nature, minDegree });
  const tags = listTags();

  const href = (patch: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    const merged = { tag: tagId, nature, degree: minDegree, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, String(v));
    return `/network${q.toString() ? `?${q}` : ""}`;
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Network</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Every tie your sources record, arranged by the ties themselves. Size is how connected a
          thing is; colour is the kind of tie. Drawn the same way every time, so it is worth
          learning the shape of.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Link
          href={href({ nature: undefined })}
          className={`rounded-full px-3 py-1 text-xs transition ${
            !nature
              ? "bg-[var(--color-ink)] text-white"
              : "border border-[var(--color-rule)] bg-white hover:bg-[var(--color-accent-soft)]"
          }`}
        >
          Every kind
        </Link>
        {(Object.keys(NATURES) as Nature[]).map((id) => (
          <Link
            key={id}
            href={href({ nature: nature === id ? undefined : id })}
            title={NATURES[id].note}
            className="rounded-full px-3 py-1 text-xs transition"
            style={
              nature === id
                ? { background: NATURES[id].colour, color: "white" }
                : { border: `1px solid ${NATURES[id].colour}`, color: NATURES[id].colour }
            }
          >
            {NATURES[id].label}
          </Link>
        ))}

        <span className="ml-auto flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
          Show things with at least
          <span className="flex overflow-hidden rounded border border-[var(--color-rule)]">
            {[1, 2, 3, 5].map((d) => (
              <Link
                key={d}
                href={href({ degree: d })}
                className={`px-2 py-1 ${
                  minDegree === d ? "bg-[var(--color-ink)] text-white" : "bg-white"
                }`}
              >
                {d}
              </Link>
            ))}
          </span>
          ties
        </span>
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <Link
            href={href({ tag: undefined })}
            className={`rounded-full px-3 py-1 text-xs ${
              !tagId ? "bg-[var(--color-accent)] text-white" : "border border-[var(--color-rule)] bg-white"
            }`}
          >
            All topics
          </Link>
          {tags.map((t) => (
            <Link
              key={t.id}
              href={href({ tag: tagId === t.id ? undefined : t.id })}
              className={`rounded-full px-3 py-1 text-xs ${
                tagId === t.id
                  ? "bg-[var(--color-accent)] text-white"
                  : "border border-[var(--color-rule)] bg-white hover:bg-[var(--color-accent-soft)]"
              }`}
            >
              {t.name}
            </Link>
          ))}
        </div>
      )}

      {net.nodes.length === 0 ? (
        <Empty
          title="Nothing to draw yet"
          hint="Relations appear as sources are read. Lower the tie threshold, or add a source."
        />
      ) : (
        <>
          <NetworkMap
            nodes={net.nodes}
            edges={net.edges}
            stars={starfield(net.width, net.height)}
            width={net.width}
            height={net.height}
          />

          <p className="text-xs text-[var(--color-muted)]">
            {net.nodes.length} of {net.total} connected entities, {net.edges.length} ties.{" "}
            {net.omitted > 0 &&
              `${net.omitted} hang off fewer than ${minDegree} tie${minDegree === 1 ? "" : "s"} and are left out — most of them are named once in passing. `}
            Faces are the entries that have a picture. Scroll the map to move around it; click
            anything to open it.
          </p>
        </>
      )}
    </div>
  );
}
