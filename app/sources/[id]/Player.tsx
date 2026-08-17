"use client";

import { useState } from "react";

/**
 * The video, playable where it lives.
 *
 * Embedded rather than linked out, because the transcript, the extracted
 * entities and the passages all sit on this page — and checking a quote against
 * what was actually said means scrubbing to the timecode, not opening YouTube in
 * another tab and losing your place.
 *
 * The iframe is only created once you press play. A YouTube embed loads a
 * substantial amount of script and sets cookies the moment it exists, and a
 * research library should not do that to you on every page view for a video you
 * did not ask to watch. Until then it is the thumbnail we already have on disk.
 *
 * youtube-nocookie.com for the same reason: it is the domain that does not set
 * tracking cookies until playback actually starts.
 */
export function Player({
  videoId,
  title,
  start,
}: {
  videoId: string;
  title: string;
  /** Seconds to open at, for jumping to a passage's timecode. */
  start?: number;
}) {
  const [playing, setPlaying] = useState(false);

  if (!playing) {
    return (
      <button
        onClick={() => setPlaying(true)}
        className="group relative block w-full overflow-hidden rounded-lg border border-[var(--color-rule)] bg-black"
        aria-label={`Play ${title}`}
      >
        <div className="aspect-video w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`}
            alt=""
            className="h-full w-full object-cover opacity-90 transition group-hover:opacity-100"
          />
        </div>
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/65 text-white shadow-lg backdrop-blur transition group-hover:scale-110 group-hover:bg-black/80">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </span>
      </button>
    );
  }

  const params = new URLSearchParams({ autoplay: "1", rel: "0", modestbranding: "1" });
  if (start && start > 0) params.set("start", String(Math.floor(start)));

  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg border border-[var(--color-rule)] bg-black">
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${videoId}?${params}`}
        title={title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="h-full w-full"
      />
    </div>
  );
}

