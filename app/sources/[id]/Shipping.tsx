import Link from "next/link";
import type { ShipmentRecord, ShippingMeta } from "@/lib/pipeline/shipment";
import { Card } from "../../components/ui";
import { dirOf } from "@/lib/dir";

export interface ShippingView {
  meta: ShippingMeta;
  /** Each shipment's entity as it stands now, after any merges. */
  entityIds: (number | null)[];
  /** Titles of the papers it is linked to, by source id. */
  titles: Record<number, string>;
  /** Other files that came in the same folder — photographs of the cargo, often. */
  siblings: { id: number; title: string }[];
}

const GOODS_COLUMNS: [keyof ShipmentRecord["goods"][number], string][] = [
  ["quantity", "Qty"],
  ["packing", "Packing"],
  ["grossKg", "Gross kg"],
  ["value", "Value"],
  ["hsCode", "HS code"],
  ["origin", "Origin"],
  ["serial", "Serial"],
];

/** The shipment a shipping paper records, read off the paper whole. */
export function Shipping({ view }: { view: ShippingView }) {
  const { meta, entityIds, titles, siblings } = view;
  return (
    <Card>
      <h2 className="font-serif text-lg font-semibold">Shipping document</h2>
      <div className="mt-3 space-y-6">
        {meta.shipments.map((s, i) => {
          const columns = GOODS_COLUMNS.filter(([k]) => s.goods.some((g) => g[k]?.toString().trim()));
          const links = meta.links.filter((l) => l.shipment === i + 1);
          const entityId = entityIds[i];
          return (
            <section key={i} className="space-y-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
                  {s.documentType}
                  {s.dateText ? ` · ${s.dateText}` : ""}
                  {s.transportMode && s.transportMode !== "unknown" ? ` · by ${s.transportMode}` : ""}
                </p>
                <h3 className="font-medium" dir={dirOf(s.name)}>
                  {entityId ? (
                    <Link href={`/pedia/${entityId}`} className="hover:underline">
                      {s.name}
                    </Link>
                  ) : (
                    s.name
                  )}
                </h3>
                <p className="mt-1 text-sm" dir={dirOf(s.summary)}>
                  {s.summary}
                </p>
              </div>

              {(s.references ?? []).length > 0 && (
                <Facts
                  label="Papers"
                  rows={(s.references ?? []).map((r) => [r.kind, `${r.value}${r.date ? ` (${r.date})` : ""}`])}
                />
              )}
              {s.parties.length > 0 && (
                <Facts
                  label="Parties"
                  rows={s.parties.map((p) => [p.role, `${p.name}${p.address ? ` — ${p.address}` : ""}`])}
                />
              )}
              {s.places.length > 0 && <Facts label="Route" rows={s.places.map((p) => [p.role, p.name])} />}

              {s.goods.length > 0 && (
                <div className="overflow-x-auto">
                  <p className="mb-1 text-sm font-medium">Goods ({s.goods.length})</p>
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-[var(--color-rule)] text-left text-xs text-[var(--color-muted)]">
                        <th className="py-1 pr-3 font-medium">#</th>
                        <th className="py-1 pr-3 font-medium">Description</th>
                        {columns.map(([, label]) => (
                          <th key={label} className="py-1 pr-3 font-medium">
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {s.goods.map((g, n) => (
                        <tr key={n} className="border-b border-[var(--color-rule)] align-top last:border-0">
                          <td className="py-1 pr-3 text-[var(--color-muted)]">{n + 1}</td>
                          <td className="py-1 pr-3">{g.description}</td>
                          {columns.map(([k]) => (
                            <td key={k} className="py-1 pr-3 whitespace-nowrap">
                              {g[k] ?? ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {s.totals && Object.values(s.totals).some((v) => v?.toString().trim()) && (
                <p className="text-sm">
                  <span className="font-medium">Totals: </span>
                  {[
                    s.totals.packages && `${s.totals.packages} packages`,
                    s.totals.grossKg && `${s.totals.grossKg} kg gross`,
                    s.totals.netKg && `${s.totals.netKg} kg net`,
                    s.totals.volumeM3 && `${s.totals.volumeM3} m³`,
                    s.totals.value && `${s.totals.value}${s.totals.currency ? ` ${s.totals.currency}` : ""}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              {s.remarks?.trim() && (
                <p className="text-sm">
                  <span className="font-medium">Remarks: </span>
                  {s.remarks}
                </p>
              )}

              {links.length > 0 && (
                <div className="text-sm">
                  <p className="font-medium">Belongs with</p>
                  <ul className="mt-1 space-y-1">
                    {links.map((l, n) => (
                      <li key={n}>
                        {l.relation}{" "}
                        <Link href={`/sources/${l.sourceId}`} className="text-[var(--color-accent)] hover:underline">
                          {titles[l.sourceId] ?? `source ${l.sourceId}`}
                        </Link>
                        {l.reason && <span className="text-[var(--color-muted)]"> — {l.reason}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          );
        })}

        {siblings.length > 0 && (
          <div className="text-sm">
            <p className="font-medium">Added in the same folder</p>
            <ul className="mt-1 flex flex-wrap gap-2">
              {siblings.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/sources/${s.id}`}
                    className="rounded-full border border-[var(--color-rule)] px-3 py-1 hover:bg-[var(--color-accent-soft)]"
                  >
                    {s.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-[var(--color-muted)]">
          Read from the paper as a whole. Every name above is quoted from it in the passages below.
        </p>
      </div>
    </Card>
  );
}

function Facts({ label, rows }: { label: string; rows: [string, string][] }) {
  return (
    <div className="text-sm">
      <p className="font-medium">{label}</p>
      <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5">
        {rows.map(([k, v], n) => (
          <div key={n} className="contents">
            <dt className="text-[var(--color-muted)] capitalize">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
