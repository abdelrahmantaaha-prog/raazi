import Link from "next/link";
import { db } from "@/lib/db";
import type { ShippingMeta } from "@/lib/pipeline/shipment";
import type { ShipmentCheck } from "@/lib/pipeline/shipcheck";
import { Badge, Empty } from "../components/ui";
import { dirOf } from "@/lib/dir";

export const dynamic = "force-dynamic";

/**
 * Every shipment the library's shipping papers record, in one table.
 *
 * A shipment lives on its paper's own page, which answers "what does this
 * paper say". This answers the other questions — what has gone from Minsk,
 * what has this company sent or received, which papers carry drones — by
 * putting them side by side and letting you narrow them.
 */
interface Row {
  sourceId: number;
  title: string;
  index: number;
  name: string;
  documentType: string;
  date: string;
  dateSort: string;
  from: string[];
  to: string[];
  parties: { role: string; name: string }[];
  goods: string[];
  goodsCount: number;
  totals: string;
  links: { sourceId: number; relation: string }[];
  flags: number;
  checked: boolean;
  photos: number;
}

const FROM_ROLES = ["origin", "port of loading"];
const TO_ROLES = ["destination", "delivery address", "port of discharge"];

export default async function Shipments({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const q = ((await searchParams).q ?? "").trim();
  const all = rows();
  const needle = q.toLowerCase();
  const shown = needle
    ? all.filter((r) =>
        [r.name, r.title, r.documentType, ...r.from, ...r.to, ...r.parties.map((p) => p.name), ...r.goods]
          .join("\n")
          .toLowerCase()
          .includes(needle)
      )
    : all;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Shipments</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Every shipment your shipping papers record — invoices, packing lists, loading plans, waybills —
          side by side. Open one for its goods, papers and the photos that came with it.
        </p>
      </div>

      <form className="flex flex-wrap gap-2" action="/shipments">
        <input
          name="q"
          defaultValue={q}
          placeholder="A company, a place, a kind of goods…"
          className="min-w-64 flex-1 rounded border border-[var(--color-rule)] bg-white px-3 py-1.5 text-sm"
        />
        <button className="rounded border border-[var(--color-rule)] bg-white px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-accent-soft)]">
          Filter
        </button>
        {q && (
          <Link href="/shipments" className="self-center text-sm text-[var(--color-muted)] hover:underline">
            Clear
          </Link>
        )}
      </form>

      {all.length === 0 ? (
        <Empty
          title="No shipping papers yet"
          hint="Add an invoice, a packing list, a loading plan or a waybill — a photo of one works too — and it is read as a shipment."
        />
      ) : shown.length === 0 ? (
        <Empty title={`No shipment mentions “${q}”.`} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--color-rule)] bg-white">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--color-rule)] text-left text-xs text-[var(--color-muted)]">
                <th className="px-3 py-2 font-medium">Shipment</th>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">From → to</th>
                <th className="px-3 py-2 font-medium">Parties</th>
                <th className="px-3 py-2 font-medium">Goods</th>
                <th className="px-3 py-2 font-medium">Totals</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.sourceId}-${r.index}`} className="border-b border-[var(--color-rule)] align-top last:border-0">
                  <td className="px-3 py-2">
                    <Link href={`/sources/${r.sourceId}`} className="font-medium hover:underline" dir={dirOf(r.name)}>
                      {r.name}
                    </Link>
                    <div className="mt-0.5 text-xs text-[var(--color-muted)]">{r.documentType}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.flags > 0 && <Badge tone="danger">{r.flags} to see online</Badge>}
                      {r.checked && r.flags === 0 && <Badge tone="ok">checked online</Badge>}
                      {r.photos > 0 && <Badge tone="quiet">{r.photos} photo{r.photos === 1 ? "" : "s"} with it</Badge>}
                    </div>
                    {r.links.map((l, n) => (
                      <div key={n} className="mt-1 text-xs text-[var(--color-muted)]">
                        {l.relation}{" "}
                        <Link href={`/sources/${l.sourceId}`} className="text-[var(--color-accent)] hover:underline">
                          {all.find((o) => o.sourceId === l.sourceId)?.name ?? `source ${l.sourceId}`}
                        </Link>
                      </div>
                    ))}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{r.date || <span className="text-[var(--color-muted)]">—</span>}</td>
                  <td className="px-3 py-2">
                    {r.from.length || r.to.length ? (
                      <>
                        {r.from.join(", ") || "?"} → {r.to.join(", ") || "?"}
                      </>
                    ) : (
                      <span className="text-[var(--color-muted)]">not stated</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.parties.length ? (
                      r.parties.map((p, n) => (
                        <div key={n}>
                          <span className="text-[var(--color-muted)]">{p.role}:</span> {p.name}
                        </div>
                      ))
                    ) : (
                      <span className="text-[var(--color-muted)]">none named</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.goods.slice(0, 4).join("; ")}
                    {r.goodsCount > 4 && <span className="text-[var(--color-muted)]"> and {r.goodsCount - 4} more</span>}
                  </td>
                  <td className="px-3 py-2">{r.totals}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function rows(): Row[] {
  const sources = db()
    .prepare(
      `SELECT s.id, s.title, s.folder_id, s.meta_json FROM sources s
        WHERE s.meta_json LIKE '%"shipping"%'`
    )
    .all() as { id: number; title: string; folder_id: number | null; meta_json: string }[];
  const photosIn = db().prepare(
    `SELECT COUNT(*) AS n FROM sources WHERE folder_id=? AND meta_json LIKE '%"photo":true%' AND meta_json NOT LIKE '%"shipping"%'`
  );

  const out: Row[] = [];
  for (const s of sources) {
    let meta: { shipping?: ShippingMeta; shippingChecks?: Record<string, ShipmentCheck> };
    try {
      meta = JSON.parse(s.meta_json);
    } catch {
      continue;
    }
    const photos = s.folder_id ? (photosIn.get(s.folder_id) as { n: number }).n : 0;
    meta.shipping?.shipments?.forEach((x, i) => {
      const check = meta.shippingChecks?.[String(i)];
      const t = x.totals ?? {};
      out.push({
        sourceId: s.id,
        title: s.title,
        index: i,
        name: x.name,
        documentType: x.documentType,
        date: x.dateText ?? "",
        dateSort: x.dateIso ?? "",
        from: x.places.filter((p) => FROM_ROLES.includes(p.role)).map((p) => p.name),
        to: x.places.filter((p) => TO_ROLES.includes(p.role)).map((p) => p.name),
        parties: x.parties.filter((p) => p.role !== "signatory").map((p) => ({ role: p.role, name: p.name })),
        goods: x.goods.map((g) => `${g.quantity && !isOne(g.quantity) ? `${g.quantity} × ` : ""}${g.description}`),
        goodsCount: x.goods.length,
        totals: [t.packages && `${t.packages} pkgs`, t.grossKg && `${t.grossKg} kg`, t.value && `${t.value} ${t.currency ?? ""}`.trim()]
          .filter(Boolean)
          .join(" · "),
        links: (meta.shipping?.links ?? []).filter((l) => l.shipment === i + 1).map((l) => ({ sourceId: l.sourceId, relation: l.relation })),
        flags: check?.lookups.filter((l) => l.status === "flag").length ?? 0,
        checked: Boolean(check),
        photos,
      });
    });
  }
  // Dated ones newest first; the undated after them, in the order they came.
  return out.sort((a, b) => (b.dateSort || "").localeCompare(a.dateSort || "") || a.sourceId - b.sourceId);
}

/** "1", "1.0", "1 pcs" — a single item, which needs no count in front of it. */
function isOne(quantity: string): boolean {
  return /^\s*1([.,٫]0+)?\s*(pcs?|pieces?|units?|ks)?\.?\s*$/i.test(quantity);
}
