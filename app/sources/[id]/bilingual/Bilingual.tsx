"use client";

import { useState } from "react";
import Link from "next/link";
import { dirOf } from "@/lib/dir";
import { useDeskHeight } from "../../../components/desk";
import type { AlignedPair } from "@/lib/translations";

/** Below this the match is a guess, and says so. */
const DOUBTFUL = 0.55;

interface Side {
  id: number;
  title: string;
  lang: string | null;
}

/**
 * The two texts, matched passage by passage.
 *
 * Rows rather than two scrolling documents: a translator joins two paragraphs
 * into one and splits the next into three, so two columns scrolled together
 * drift apart within a page and are useless by the second chapter. Each row
 * holds however many passages each side needed, which keeps the correspondence
 * true all the way down and makes an omission visible as an empty half rather
 * than as everything below it being wrong.
 *
 * A row the matcher was unsure of is marked. The alternative — hiding the
 * doubtful ones — would mean the text you are reading is sometimes not the
 * translation of the text beside it and nothing tells you which times.
 */
export function Bilingual({
  original,
  translation,
  others,
  pairs,
  covered,
}: {
  original: Side;
  translation: Side;
  others: { id: number; title: string }[];
  pairs: AlignedPair[];
  covered: number;
}) {
  const [onlySure, setOnlySure] = useState(false);
  const desk = useDeskHeight(true, { min: "28rem" });

  const shown = onlySure ? pairs.filter((p) => p.confidence >= DOUBTFUL) : pairs;
  const doubtful = pairs.filter((p) => p.confidence < DOUBTFUL).length;
  const gaps = pairs.filter((p) => !p.original.length || !p.translation.length).length;

  return (
    <div className="space-y-4">
      <div ref={desk.headingRef as React.RefObject<HTMLDivElement>} className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-serif text-2xl font-semibold">{original.title}</h1>
          <Link href={`/sources/${original.id}`} className="text-sm text-[var(--color-accent)] hover:underline">
            Read on its own
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--color-muted)]">
          <span>
            beside{" "}
            {others.length > 1 ? (
              <select
                value={translation.id}
                onChange={(e) => {
                  window.location.href = `/sources/${original.id}/bilingual?with=${e.target.value}`;
                }}
                className="rounded border border-[var(--color-rule)] bg-white px-1.5 py-0.5 text-sm"
                aria-label="Which translation"
              >
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title}
                  </option>
                ))}
              </select>
            ) : (
              <Link href={`/sources/${translation.id}`} className="text-[var(--color-ink)] hover:underline">
                {translation.title}
              </Link>
            )}
          </span>
          <span className="tabular-nums">
            {pairs.length} matched passage{pairs.length === 1 ? "" : "s"} · {Math.round(covered * 100)}% of the book
          </span>
          {doubtful > 0 && (
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={onlySure}
                onChange={(e) => setOnlySure(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--color-accent)]"
              />
              hide the {doubtful} uncertain
            </label>
          )}
          {gaps > 0 && <span>{gaps} with nothing on one side</span>}
        </div>
      </div>

      {/* One scrolling area, so the heading stays and the rows carry both
          texts along together. */}
      <div
        ref={desk.ref}
        style={desk.style}
        className="overflow-y-auto overscroll-contain rounded-lg border border-[var(--color-rule)] bg-white"
      >
        {shown.length === 0 ? (
          <p className="p-8 text-center text-sm text-[var(--color-muted)]">
            Nothing matched. The two texts may be too different for the passage matcher, or one of them
            has not been read in yet.
          </p>
        ) : (
          <ol className="divide-y divide-[var(--color-rule)]">
            {shown.map((pair) => (
              <li
                key={pair.id}
                className={`grid gap-x-6 gap-y-2 px-4 py-4 md:grid-cols-2 ${
                  pair.confidence < DOUBTFUL ? "bg-[var(--color-accent-soft)]/40" : ""
                }`}
              >
                <Column side={original} chunks={pair.original} />
                <Column side={translation} chunks={pair.translation} />
                {pair.confidence < DOUBTFUL && (
                  <p className="md:col-span-2 text-[0.68rem] text-[var(--color-muted)]">
                    An uncertain match — the two passages are the right length for each other and nothing
                    else says they belong together.
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Column({ side, chunks }: { side: Side; chunks: AlignedPair["original"] }) {
  if (!chunks.length) {
    return (
      <p className="self-center text-sm italic text-[var(--color-muted)]">
        Nothing here in {side.title}.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {chunks.map((c) => (
        <div key={c.id}>
          {c.locator && (
            <p className="mb-0.5 text-[0.68rem] uppercase tracking-[0.1em] text-[var(--color-muted)]">
              {c.locator}
            </p>
          )}
          <p dir={dirOf(c.text)} className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">
            {c.text}
          </p>
        </div>
      ))}
    </div>
  );
}
