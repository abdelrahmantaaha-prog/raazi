import type { EntityType } from "@/lib/types";

/**
 * An entity's picture at list size, or its initial when there is none.
 *
 * The initial is not a placeholder for a missing thing — most entities in a
 * research library will never have a photograph, and the great majority of any
 * list is going to be initials. So it is drawn as a deliberate mark rather than
 * as an empty frame: same size, same weight, no broken-image grey.
 *
 * People are round and everything else is square, which is the same distinction
 * the connections graph draws with circles and squares.
 */
export function Avatar({
  entityId,
  name,
  type,
  has,
  size = 44,
}: {
  entityId: number;
  name: string;
  type: EntityType;
  has: boolean;
  size?: number;
}) {
  const round = type === "person";
  const shape = round ? "rounded-full" : "rounded-md";

  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center overflow-hidden border border-[var(--color-rule)] bg-[var(--color-accent-soft)] ${shape}`}
      style={{ width: size, height: size }}
    >
      {has ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/entities/${entityId}/portrait`}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          className="font-serif text-[var(--color-accent)]"
          style={{ fontSize: Math.round(size * 0.42) }}
        >
          {name.trim().charAt(0)}
        </span>
      )}
    </span>
  );
}
