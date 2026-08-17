"use client";

import Link from "next/link";
import type { TagWithCounts } from "@/lib/tags";

/**
 * The one control that answers "show me only this topic". Rendered as links
 * rather than a dropdown so the current filter lives in the URL — shareable,
 * bookmarkable, and survives a reload.
 */
export function TagFilter({
  tags,
  active,
  basePath,
  extra = {},
}: {
  tags: TagWithCounts[];
  active?: number;
  basePath: string;
  extra?: Record<string, string | undefined>;
}) {
  if (tags.length === 0) return null;

  const href = (tagId?: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
    if (tagId) params.set("tag", String(tagId));
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs uppercase tracking-wide text-[var(--color-muted)]">Topic</span>
      <Link
        href={href()}
        className={`rounded-full px-3 py-1 text-sm transition ${
          !active
            ? "bg-[var(--color-ink)] text-white"
            : "border border-[var(--color-rule)] bg-white hover:bg-[var(--color-accent-soft)]"
        }`}
      >
        Everything
      </Link>
      {tags.map((t) => {
        const on = active === t.id;
        return (
          <Link
            key={t.id}
            href={href(t.id)}
            title={`${t.sources} source${t.sources === 1 ? "" : "s"} · ${t.entities} entit${t.entities === 1 ? "y" : "ies"}`}
            className={`rounded-full px-3 py-1 text-sm transition ${
              on ? "text-white" : "border border-[var(--color-rule)] bg-white hover:bg-[var(--color-accent-soft)]"
            }`}
            style={on ? { backgroundColor: t.color ?? "var(--color-accent)" } : undefined}
          >
            {t.name}
            <span className={`ml-1.5 text-xs ${on ? "opacity-75" : "opacity-55"}`}>{t.entities}</span>
          </Link>
        );
      })}
      <Link
        href="/tags"
        className="rounded-full px-2.5 py-1 text-sm text-[var(--color-muted)] transition hover:bg-[var(--color-accent-soft)]"
        title="Manage topics"
      >
        ⋯
      </Link>
    </div>
  );
}

/** A small coloured label. Used wherever a tag appears outside the filter bar. */
export function TagChip({
  name,
  color,
  origin,
  onRemove,
}: {
  name: string;
  color?: string | null;
  origin?: "derived" | "manual";
  onRemove?: () => void;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs"
      style={{ borderColor: color ?? "var(--color-rule)", color: color ?? "inherit" }}
      title={
        origin === "derived"
          ? "From a source filed under this topic"
          : origin === "manual"
            ? "You added this one"
            : undefined
      }
    >
      {name}
      {origin === "manual" && <span className="opacity-60">•</span>}
      {onRemove && (
        <button onClick={onRemove} className="opacity-50 hover:opacity-100" title="Remove">
          ×
        </button>
      )}
    </span>
  );
}
