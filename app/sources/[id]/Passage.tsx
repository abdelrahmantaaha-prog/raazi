"use client";

import { Fragment } from "react";
import Link from "next/link";
import { Badge } from "../../components/ui";
import { dirOf } from "@/lib/dir";

interface MentionRef {
  surface: string;
  entityId: number;
  name: string;
}

/**
 * A passage with its entities highlighted in place. Longest surface forms are
 * matched first so "Gamal Abdel Nasser" wins over "Nasser" and you don't get a
 * link nested inside a link.
 */
export function Passage({
  text,
  locator,
  extracted,
  mentions,
}: {
  text: string;
  locator: string;
  extracted: boolean;
  mentions: MentionRef[];
}) {
  const unique = new Map<string, MentionRef>();
  for (const m of mentions) {
    if (m.surface.trim().length > 1) unique.set(m.surface, m);
  }
  const surfaces = [...unique.keys()].sort((a, b) => b.length - a.length);

  return (
    <article className="rounded-lg border border-[var(--color-rule)] bg-white p-4">
      <div className="mb-2 flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <span>{locator || "—"}</span>
        {extracted ? <Badge tone="ok">read</Badge> : <Badge tone="quiet">not read yet</Badge>}
        {mentions.length > 0 && <span>· {unique.size} entit{unique.size === 1 ? "y" : "ies"}</span>}
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed" dir={dirOf(text)}>
        {highlight(text, surfaces, unique)}
      </p>
    </article>
  );
}

function highlight(text: string, surfaces: string[], map: Map<string, MentionRef>) {
  if (surfaces.length === 0) return text;

  const escaped = surfaces.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "g");
  const parts = text.split(re);

  return parts.map((part, i) => {
    const hit = map.get(part);
    if (!hit) return <Fragment key={i}>{part}</Fragment>;
    return (
      <Link
        key={i}
        href={`/pedia/${hit.entityId}`}
        title={hit.name}
        className="rounded bg-[var(--color-accent-soft)] px-0.5 text-[var(--color-accent)] hover:underline"
      >
        {part}
      </Link>
    );
  });
}
