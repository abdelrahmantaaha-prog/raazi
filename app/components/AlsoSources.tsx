import Link from "next/link";
import type { CalendarRow } from "@/lib/calendar";

/** The other records a line stands for: more outlets, or the same happening filed on another entity. */
export function AlsoSources({ row }: { row: CalendarRow }) {
  if (!row.also.length) return null;
  const seen = new Set<string>([`${row.entity_id}:${row.source_id}`]);
  const links = row.also.filter((a) => {
    const key = `${a.entity_id}:${a.source_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!links.length) return null;
  return (
    <span>
      also{" "}
      {links.map((a, i) => (
        <span key={a.id}>
          {i ? ", " : ""}
          {a.source_id ? (
            <Link
              href={`/sources/${a.source_id}${a.chunk_id ? `?chunk=${a.chunk_id}` : ""}`}
              className="hover:text-[var(--color-accent)] hover:underline"
              title={`${a.entity} — ${a.source_title ?? ""}`}
            >
              {a.outlet ?? a.source_title ?? a.entity}
            </Link>
          ) : (
            <Link href={`/pedia/${a.entity_id}`} className="hover:underline">
              {a.entity}
            </Link>
          )}
        </span>
      ))}
    </span>
  );
}
