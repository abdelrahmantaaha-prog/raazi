"use client";

import { useEffect, useRef, useState } from "react";
import { dirOf } from "@/lib/dir";

export interface Sense {
  partOfSpeech: string;
  language: string;
  definitions: string[];
}

export interface Definition {
  word: string;
  lang: string;
  senses: Sense[];
  url: string;
  native: boolean;
}

export interface LookupAt {
  word: string;
  /** Viewport coordinates of the selection, so the card lands beside it. */
  x: number;
  y: number;
}

/**
 * A definition, where you are looking.
 *
 * Deliberately small and deliberately dumb: it fetches one word and shows what
 * came back. No model is involved, which is why it can be instant and why the
 * answer is a dictionary's rather than a plausible-sounding paraphrase of one.
 */
export function Lookup({
  at,
  theme,
  onClose,
}: {
  at: LookupAt;
  theme: { bg: string; fg: string; muted: string; rule: string };
  onClose: () => void;
}) {
  const [state, setState] = useState<"loading" | "ready" | "empty">("loading");
  const [def, setDef] = useState<Definition | null>(null);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setState("loading");
    setDef(null);

    void (async () => {
      try {
        const res = await fetch(`/api/dictionary?word=${encodeURIComponent(at.word)}`);
        const data = (await res.json()) as { definition: Definition | null };
        if (!live) return;
        setDef(data.definition);
        setState(data.definition ? "ready" : "empty");
      } catch {
        if (live) setState("empty");
      }
    })();

    return () => {
      live = false;
    };
  }, [at.word]);

  // Clicking anywhere else, or pressing Escape, puts it away.
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
    // Deferred: the mouseup that made the selection would otherwise close this
    // in the same tick it opened.
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    document.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const WIDTH = 320;
  const left = Math.max(12, Math.min(at.x - WIDTH / 2, window.innerWidth - WIDTH - 12));
  // Above the selection when there is room, below it when there isn't.
  const below = at.y < window.innerHeight / 2;

  return (
    <div
      ref={card}
      className="fixed z-[60] rounded-lg p-3 text-[0.85rem] shadow-xl"
      style={{
        left,
        top: below ? at.y + 22 : undefined,
        bottom: below ? undefined : window.innerHeight - at.y + 16,
        width: WIDTH,
        maxHeight: "min(22rem, 45vh)",
        overflowY: "auto",
        background: theme.bg,
        color: theme.fg,
        border: `1px solid ${theme.rule}`,
        fontFamily: "var(--font-sans)",
        textAlign: "start",
        hyphens: "manual",
      }}
      role="dialog"
      aria-label={`Definition of ${at.word}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <strong
          className="text-[1.05rem] font-semibold leading-tight"
          style={{ fontFamily: "var(--font-serif)" }}
          dir={dirOf(def?.word ?? at.word)}
        >
          {def?.word ?? at.word}
        </strong>
        <button
          onClick={onClose}
          className="shrink-0 leading-none opacity-60 hover:opacity-100"
          style={{ color: theme.muted }}
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="mt-1.5 mb-2 h-px" style={{ background: theme.rule }} />

      {state === "loading" && (
        <p className="mt-2" style={{ color: theme.muted }}>
          Looking it up…
        </p>
      )}

      {state === "empty" && (
        <p className="mt-2" style={{ color: theme.muted }}>
          Wiktionary has no entry for this one. It may be a name, an inflected form, or simply
          missing.
        </p>
      )}

      {state === "ready" && def && (
        <>
          <div className="space-y-3">
            {def.senses.map((s, i) => (
              <div key={i}>
                {/* The variety matters: "Egyptian Arabic" and "Arabic" are not
                    the same claim about what a word means. */}
                <div className="mb-1 flex items-baseline gap-1.5">
                  <span
                    className="text-[0.7rem] font-medium italic"
                    style={{ color: theme.fg, opacity: 0.75 }}
                  >
                    {s.partOfSpeech.toLowerCase()}
                  </span>
                  {s.language !== "English" && (
                    <span
                      className="rounded-full px-1.5 py-px text-[0.6rem] uppercase tracking-[0.08em]"
                      style={{ background: theme.rule, color: theme.muted }}
                    >
                      {s.language}
                    </span>
                  )}
                </div>
                <ol className="space-y-1" dir={dirOf(s.definitions[0] ?? "")}>
                  {s.definitions.map((d, j) => (
                    <li key={j} className="flex gap-2 leading-snug">
                      <span
                        className="shrink-0 tabular-nums"
                        style={{ color: theme.muted, opacity: 0.7 }}
                      >
                        {j + 1}
                      </span>
                      <span>{d}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
          <div
            className="mt-3 flex items-baseline justify-between gap-2 border-t pt-2"
            style={{ borderColor: theme.rule }}
          >
            <a
              href={def.url}
              target="_blank"
              rel="noreferrer"
              className="text-[0.7rem] hover:underline"
              style={{ color: theme.muted }}
            >
              {def.native ? "الويكاموس العربي ↗" : "English Wiktionary ↗"}
            </a>
            {/* Said plainly, because they are not the same thing: one is a
                dictionary of the language you are reading, the other is a
                translation of the word into English. */}
            {!def.native && def.lang === "ar" && (
              <span className="text-[0.65rem]" style={{ color: theme.muted }}>
                translated — no Arabic entry
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
