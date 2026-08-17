import Link from "next/link";
import { listEntities, typeCounts } from "@/lib/queries";
import { listTags } from "@/lib/tags";
import { ENTITY_LABEL, ENTITY_TYPES, type EntityType } from "@/lib/types";
import { Badge, Empty } from "../components/ui";
import { TagFilter } from "../components/TagFilter";
import { Avatar } from "../components/Avatar";
import { MapView } from "../components/MapView";
import { havePortraits, locatedEntities } from "@/lib/portraits";

export const dynamic = "force-dynamic";

export default async function Pedia({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; q?: string; tag?: string; all?: string }>;
}) {
  const params = await searchParams;
  const type = (params.type ?? "all") as EntityType | "all";
  const q = params.q ?? "";
  const tagId = Number(params.tag ?? 0) || undefined;
  const showAll = params.all === "1";

  /**
   * The default cap keeps the page light; past it, the truncation is said out
   * loud with a link instead of happening silently. The list used to stop at
   * 500 while the tab counts kept counting — entities 501+ existed in every
   * number on the page and were reachable only by search.
   */
  const LIMIT = 500;
  const entities = listEntities({ type, q, tagId, limit: showAll ? 100000 : LIMIT });
  // One directory read for the whole list, rather than a request per row that
  // is answered 404 for most of them.
  const pictured = havePortraits();
  // Only for the Places tab: a map of everything else would be a map of the
  // handful of entities that happen to carry a coordinate, which says nothing.
  const shown = new Set(entities.map((e) => e.id));
  const located = type === "place" ? locatedEntities("place").filter((p) => shown.has(p.id)) : [];
  const counts = typeCounts(tagId);
  const tags = listTags();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const href = (t: string) =>
    `/pedia?type=${t}${q ? `&q=${encodeURIComponent(q)}` : ""}${tagId ? `&tag=${tagId}` : ""}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Pedia</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Everyone and everything your sources name, with the evidence behind it.
        </p>
      </div>

      <TagFilter tags={tags} active={tagId} basePath="/pedia" extra={{ type, q: q || undefined }} />

      <form className="flex gap-2" action="/pedia">
        <input type="hidden" name="type" value={type} />
        {tagId ? <input type="hidden" name="tag" value={tagId} /> : null}
        <input
          name="q"
          defaultValue={q}
          placeholder="Find by name or alias…"
          className="w-full max-w-md rounded border border-[var(--color-rule)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <button className="rounded border border-[var(--color-rule)] bg-white px-3 py-2 text-sm font-medium hover:bg-[var(--color-accent-soft)]">
          Search
        </button>
      </form>

      <div className="flex flex-wrap gap-1 border-b border-[var(--color-rule)] pb-3">
        <Tab href={href("all")} active={type === "all"} label="All" count={total} />
        {ENTITY_TYPES.filter((t) => counts[t]).map((t) => (
          <Tab key={t} href={href(t)} active={type === t} label={ENTITY_LABEL[t]} count={counts[t]} />
        ))}
      </div>

      {located.length > 0 && (
        <section className="space-y-2">
          <MapView
            markers={located}
            width={960}
            height={420}
            label={`Map of ${located.length} places in this library`}
          />
          <p className="text-xs text-[var(--color-muted)]">
            {located.length} of {entities.length} place
            {entities.length === 1 ? "" : "s"} here carry a coordinate from Wikidata. The rest are
            named in your sources but not yet matched to a record — a place is only plotted when
            the name and the kind of thing both agree.
          </p>
        </section>
      )}

      {entities.length === 0 ? (
        <Empty
          title={q ? `Nothing matches “${q}”` : "The pedia is empty"}
          hint={q ? undefined : "Add a source from the Library and it will fill itself in."}
        />
      ) : (
        <ul className="divide-y divide-[var(--color-rule)] rounded-lg border border-[var(--color-rule)] bg-white">
          {entities.map((e) => (
            <li key={e.id}>
              <Link
                href={`/pedia/${e.id}`}
                className="flex items-start gap-4 px-4 py-3 transition hover:bg-[var(--color-accent-soft)]"
              >
                <Avatar
                  entityId={e.id}
                  name={e.canonical_name}
                  type={e.type}
                  has={pictured.has(e.id)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{e.canonical_name}</span>
                    {e.starred === 1 && <span title="Starred">★</span>}
                    {e.entry_state === "stale" && <Badge tone="warn">needs update</Badge>}
                    {e.entry_state === "none" && <Badge tone="quiet">no entry yet</Badge>}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-sm text-[var(--color-muted)]">
                    {e.summary || e.disambiguator || "—"}
                  </p>
                </div>
                <div className="shrink-0 text-right text-sm text-[var(--color-muted)]">
                  <div>{e.mentions} quote{e.mentions === 1 ? "" : "s"}</div>
                  <div className="text-xs">
                    {e.sources} source{e.sources === 1 ? "" : "s"}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {!showAll && entities.length >= LIMIT && (
        <p className="text-sm text-[var(--color-muted)]">
          Showing the {LIMIT} with the most evidence.{" "}
          <Link
            href={`${href(type)}&all=1`}
            className="text-[var(--color-accent)] hover:underline"
          >
            Show every entry in this tab
          </Link>
          .
        </p>
      )}
    </div>
  );
}

function Tab({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      className={`rounded px-3 py-1.5 text-sm font-medium transition ${
        active
          ? "bg-[var(--color-accent)] text-white"
          : "text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
      }`}
    >
      {label}
      <span className={`ml-1.5 text-xs ${active ? "opacity-75" : "opacity-60"}`}>{count}</span>
    </Link>
  );
}
