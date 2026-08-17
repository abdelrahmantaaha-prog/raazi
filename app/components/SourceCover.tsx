"use client";

import { useState } from "react";

/**
 * A source's cover, with a drawn one as the fallback.
 *
 * Most research sources are not catalogued books — working papers, articles,
 * transcripts — so the fallback is not an error state and should not look like
 * one. It is a plain typographic cover, tinted from the title so the same
 * source is the same colour every time and the shelf stays recognisable.
 */

const SPINES = [
  ["#7a4b2a", "#a9713f"],
  ["#2f6b5b", "#489683"],
  ["#4a5a8a", "#6d7fb5"],
  ["#8a4a5e", "#b56b81"],
  ["#5f6b2a", "#8a9743"],
  ["#3f5f7a", "#5d84a6"],
  ["#6b3a6b", "#955894"],
  ["#8a5a2a", "#b57f43"],
];

const KIND_MARK: Record<string, string> = {
  pdf: "PDF",
  epub: "EPUB",
  text: "TEXT",
  url: "WEB",
  // "media" covers both a podcast and a lecture on video. Labelling all of it
  // AUDIO was simply wrong for the YouTube half of the shelf, which is most of
  // it — the caller passes `ratio` and that is the honest signal.
  media: "MEDIA",
};

function tint(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return SPINES[h % SPINES.length] as [string, string];
}

export function SourceCover({
  sourceId,
  title,
  author,
  kind,
  className = "",
  ratio = "book",
}: {
  sourceId: number;
  title: string;
  author: string | null;
  kind: string;
  className?: string;
  /** A video still is 16:9; a book cover is not. Forcing one into the other
   *  either letterboxes it or crops the face off the speaker. */
  ratio?: "book" | "video";
}) {
  const [failed, setFailed] = useState(false);
  const [from, to] = tint(title);

  return (
    <div
      className={`relative w-full overflow-hidden rounded shadow-sm ring-1 ring-black/10 ${
        ratio === "video" ? "aspect-video" : "aspect-[2/3]"
      } ${className}`}
      style={{ background: `linear-gradient(150deg, ${from}, ${to})` }}
    >
      {!failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/sources/${sourceId}/cover`}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}

      {failed && (
        <div className="absolute inset-0 flex flex-col justify-between p-3 text-white">
          <span className="text-[0.6rem] font-medium uppercase tracking-[0.18em] opacity-70">
            {kind === "media" && ratio === "video" ? "VIDEO" : (KIND_MARK[kind] ?? kind)}
          </span>
          <span
            className="font-serif leading-tight"
            style={{ fontSize: title.length > 60 ? "0.78rem" : title.length > 30 ? "0.9rem" : "1.05rem" }}
          >
            {title.length > 110 ? `${title.slice(0, 110)}…` : title}
          </span>
          <span className="truncate text-[0.65rem] opacity-75">{author ?? ""}</span>
        </div>
      )}

      {/* The spine, so a row of these reads as a shelf. Only on book covers —
          on a video still it just looks like a rendering fault. */}
      {ratio === "book" && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-[6px]"
          style={{ background: "linear-gradient(90deg, rgba(0,0,0,.28), rgba(0,0,0,0))" }}
        />
      )}
    </div>
  );
}
