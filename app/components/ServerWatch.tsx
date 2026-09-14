"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { formatDateTime } from "@/lib/dates";

interface FollowView {
  follower: boolean;
  primaryHost: string | null;
  lastSyncAt: string | null;
  offlineSince: string | null;
  state: string | null;
}

const COPY_TITLE = "Corpus · this computer's copy";

/**
 * Says so, plainly, when the server behind this window stops answering — and,
 * on a follower's copy, whose copy this is and how current.
 *
 * Every window asks the server it came from for its hello every ten seconds.
 * Two misses in a row put a red bar across the top: nothing you change can be
 * saved while it shows. On a copy kept by a follower (lib/follow.ts) an amber
 * bar says which Corpus it follows, whether that one is up, and when the copy
 * was last brought up to date — so working offline is never mistaken for
 * working on the real thing.
 */
export function ServerWatch() {
  const [down, setDown] = useState(false);
  const [copy, setCopy] = useState<FollowView | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    let misses = 0;
    let stopped = false;
    const check = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      try {
        const res = await fetch("/api/hello", { cache: "no-store", signal: ctrl.signal });
        if (!res.ok) throw new Error(String(res.status));
        misses = 0;
        if (stopped) return;
        setDown(false);
        const follow = await fetch("/api/sync/follow", { cache: "no-store" });
        if (follow.ok && !stopped) {
          const view = (await follow.json()) as FollowView;
          setCopy(view.follower ? view : null);
        }
      } catch {
        misses += 1;
        if (misses >= 2 && !stopped) setDown(true);
      } finally {
        clearTimeout(timer);
      }
    };
    void check();
    const every = window.setInterval(() => void check(), 10_000);
    const onBack = () => void check();
    window.addEventListener("online", onBack);
    window.addEventListener("focus", onBack);
    return () => {
      stopped = true;
      window.clearInterval(every);
      window.removeEventListener("online", onBack);
      window.removeEventListener("focus", onBack);
    };
  }, []);

  // A copy's window is titled as one, so it is never taken for the primary's —
  // by you, or by the launcher looking for the window to bring forward.
  useEffect(() => {
    if (!copy) return;
    const apply = () => {
      if (document.title !== COPY_TITLE) document.title = COPY_TITLE;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [copy, pathname]);

  const host = copy?.primaryHost ?? "the other computer";
  const away = copy && (copy.offlineSince || copy.state === "offline");
  const conflict = copy?.state === "conflict";

  return (
    <>
      {down ? (
        <div
          role="alert"
          className="fixed inset-x-0 top-0 z-[60] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-red-700 px-4 py-2 text-sm text-white shadow-lg"
        >
          <strong>The Corpus server is down.</strong>
          <span>Nothing you change in this window can be saved until it answers again.</span>
          {!copy ? (
            <span className="opacity-90">
              If this computer keeps a copy, the Corpus icon in the notification area offers to switch to it.
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-full bg-white/15 px-3 py-0.5 text-xs font-medium hover:bg-white/25"
          >
            Try again
          </button>
        </div>
      ) : null}

      {copy ? (
        <div
          role="status"
          className={`ms-14 px-4 py-2 text-sm lg:ms-48 ${
            away || conflict ? "bg-amber-100 text-amber-950" : "bg-sky-50 text-sky-950"
          }`}
        >
          <div className="mx-auto max-w-6xl">
            {conflict ? (
              <>
                <strong>Both copies changed while apart.</strong> Choose which to keep from the Corpus icon in the
                notification area; until then you are working on this computer&apos;s copy.
              </>
            ) : away ? (
              <>
                <strong>Working from this computer&apos;s copy — {host} is down.</strong> It has everything up to{" "}
                {copy.lastSyncAt ? formatDateTime(copy.lastSyncAt) : "its last copy"}. What you change here goes back to{" "}
                {host} as soon as it answers again.
              </>
            ) : (
              <>
                <strong>This is this computer&apos;s copy of {host}</strong>, kept in step every few minutes
                {copy.lastSyncAt ? ` (last at ${formatDateTime(copy.lastSyncAt)})` : ""}. Work in {host}&apos;s window —
                what you change here would have to be sent back. This window can be closed.
              </>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
