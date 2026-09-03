"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Renaming, pinning and separating.
 *
 * Grouping is a guess, and the two ways it goes wrong need different repairs:
 * an account filed with the wrong story is separated out, and a story that
 * matters gets a name of your own and stays at the top. Both are one click,
 * because a guess you cannot correct quickly is a guess you stop trusting.
 */
export function StoryActions({
  id,
  title,
  pinned,
  splitSourceId,
  compact = false,
}: {
  id: number;
  title?: string;
  pinned?: boolean;
  splitSourceId?: number;
  compact?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(title ?? "");
  const [error, setError] = useState<string | null>(null);

  async function act(body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/stories/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; storyId?: number };
      if (!res.ok) throw new Error(data.error ?? "That did not work.");
      if (data.storyId && splitSourceId) router.push(`/stories/${data.storyId}`);
      else router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setRenaming(false);
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => act({ action: "split", sourceId: splitSourceId })}
        disabled={busy}
        title="This is not the same story"
        className="rounded border border-[var(--color-rule)] px-2 py-0.5 text-xs text-[var(--color-muted)] hover:border-[var(--color-accent)] disabled:opacity-50"
      >
        Not this story
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {renaming ? (
          <>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && value.trim()) act({ action: "rename", title: value.trim() });
                if (e.key === "Escape") setRenaming(false);
              }}
              autoFocus
              className="rounded border border-[var(--color-rule)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <button
              type="button"
              onClick={() => value.trim() && act({ action: "rename", title: value.trim() })}
              disabled={busy}
              className="rounded border border-[var(--color-rule)] px-2 py-1 text-sm disabled:opacity-50"
            >
              Save
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setRenaming(true)}
            className="rounded border border-[var(--color-rule)] px-2 py-1 text-sm hover:border-[var(--color-accent)]"
          >
            Rename
          </button>
        )}
        <button
          type="button"
          onClick={() => act({ action: "pin", pinned: !pinned })}
          disabled={busy}
          className="rounded border border-[var(--color-rule)] px-2 py-1 text-sm hover:border-[var(--color-accent)] disabled:opacity-50"
        >
          {pinned ? "Unpin" : "Pin"}
        </button>
      </div>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
