"use client";

import { useEffect, useRef, useState } from "react";
import { dirOf } from "@/lib/dir";
import { IconReview, IconSend } from "../../components/Icons";

export interface SendAt {
  /** The selected passage, as the reader saw it. */
  text: string;
  /** The chunk the selection began in, when it began inside one. */
  chunkId: number | null;
  /** Viewport coordinates of the selection, so the card lands beside it. */
  x: number;
  y: number;
}

interface DraftRow {
  id: number;
  title: string;
  updated_at: string;
  notes: number;
}

/** Where the last passage went, so the next one goes there without asking. */
const LAST_DRAFT = "corpus:write:last-draft";

/**
 * Select a passage while reading, send it to the writing desk.
 *
 * The passage lands on the draft's Sources shelf — copied, cited to this
 * source at this place, and linked back to the chunk so it can be checked —
 * exactly as if you had found it through the desk's search. The difference is
 * the direction: the desk's search is for a phrase you remember; this is for
 * the sentence you are looking at now, before you lose it.
 *
 * One click when you have sent something before: the last draft you sent to
 * is remembered and offered first. The list is there for when it is a
 * different piece, and a new draft can be made from here without leaving the
 * page.
 */
export function SendToWrite({
  at,
  sourceId,
  theme,
  onClose,
  onReview,
}: {
  at: SendAt;
  sourceId: number;
  theme: { bg: string; fg: string; muted: string; rule: string };
  onClose: () => void;
  /** Opens a literature review of the passage; the reader holds the window, since this card closes on any click outside it. */
  onReview?: () => void;
}) {
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: number; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const card = useRef<HTMLDivElement>(null);

  const last = (() => {
    try {
      const raw = localStorage.getItem(LAST_DRAFT);
      return raw ? (JSON.parse(raw) as { id: number; title: string }) : null;
    } catch {
      return null;
    }
  })();

  async function loadDrafts() {
    if (drafts) return drafts;
    const res = await fetch("/api/drafts", { cache: "no-store" });
    const data = (await res.json()) as { drafts: DraftRow[] };
    setDrafts(data.drafts ?? []);
    return data.drafts ?? [];
  }

  async function send(draftId: number, title: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/drafts/${draftId}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: at.text, kind: "passage", sourceId, chunkId: at.chunkId ?? undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "That did not work.");
      try {
        localStorage.setItem(LAST_DRAFT, JSON.stringify({ id: draftId, title }));
      } catch {
        /* a private window; the list is still there */
      }
      setDone({ id: draftId, title });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendToNew() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim() || "Untitled" }),
      });
      const data = (await res.json()) as { id: number };
      await send(data.id, newTitle.trim() || "Untitled");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  // Clicking anywhere else, or pressing Escape, puts it away — deferred a
  // tick so the mouseup that made the selection cannot close it at once.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!card.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const t = setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey, true);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  // Beside the selection, kept on screen.
  const width = 300;
  const left = Math.max(8, Math.min(at.x - width / 2, window.innerWidth - width - 8));
  const above = at.y > 160;
  const style: React.CSSProperties = {
    position: "fixed",
    left,
    width,
    ...(above ? { bottom: window.innerHeight - at.y + 10 } : { top: at.y + 24 }),
    background: theme.bg,
    color: theme.fg,
    border: `1px solid ${theme.rule}`,
    boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
    zIndex: 60,
  };

  const words = at.text.split(/\s+/).filter(Boolean).length;

  return (
    <div ref={card} role="dialog" aria-label="Send to Write" style={style} className="rounded-lg p-3 text-sm">
      <p className="line-clamp-3 text-xs italic" dir={dirOf(at.text)} style={{ color: theme.muted }}>
        “{at.text}”
      </p>
      <p className="mt-1 text-[11px]" style={{ color: theme.muted }}>
        {words} word{words === 1 ? "" : "s"} · cited to this source
      </p>

      {done ? (
        <p className="mt-2">
          Sent to <span className="font-medium">{done.title}</span>.{" "}
          <a href={`/write?draft=${done.id}`} target="_blank" rel="noreferrer" className="underline">
            Open the desk
          </a>
        </p>
      ) : choosing ? (
        <div className="mt-2 space-y-2">
          {drafts === null ? (
            <p style={{ color: theme.muted }}>Loading drafts…</p>
          ) : (
            <ul className="max-h-40 space-y-1 overflow-y-auto">
              {drafts.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void send(d.id, d.title)}
                    className="w-full rounded px-2 py-1 text-left hover:opacity-80"
                    style={{ border: `1px solid ${theme.rule}` }}
                  >
                    <span className="block truncate">{d.title}</span>
                    <span className="block text-[11px]" style={{ color: theme.muted }}>
                      {d.notes} on the shelf
                    </span>
                  </button>
                </li>
              ))}
              {drafts.length === 0 ? <li style={{ color: theme.muted }}>No drafts yet.</li> : null}
            </ul>
          )}
          <div className="flex gap-1">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="New draft…"
              className="min-w-0 flex-1 rounded px-2 py-1 text-sm outline-none"
              style={{ border: `1px solid ${theme.rule}`, background: "transparent", color: theme.fg }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void sendToNew();
              }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void sendToNew()}
              className="rounded px-2 py-1 text-xs"
              style={{ background: theme.fg, color: theme.bg }}
            >
              Make &amp; send
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {last ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void send(last.id, last.title)}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium disabled:opacity-50"
              style={{ background: theme.fg, color: theme.bg }}
              title={`Send to “${last.title}”, where the last one went`}
            >
              <IconSend size={13} /> Send to {last.title.length > 22 ? `${last.title.slice(0, 22)}…` : last.title}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setChoosing(true);
              void loadDrafts();
            }}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs disabled:opacity-50"
            style={last ? { border: `1px solid ${theme.rule}` } : { background: theme.fg, color: theme.bg }}
          >
            {last ? "Another draft…" : <><IconSend size={13} /> Send to Write…</>}
          </button>
          {onReview ? (
            <button
              type="button"
              onClick={onReview}
              title="Claude searches for research, papers and news on this passage, and writes a short review of what has been written"
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs"
              style={{ border: `1px solid ${theme.rule}` }}
            >
              <IconReview size={13} /> Literature review &amp; news
            </button>
          ) : null}
        </div>
      )}

      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
