"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card } from "../components/ui";
import { dirOf } from "@/lib/dir";
import { IDEA_STATES } from "@/lib/idea-states";
// Types only — erased at compile time, so importing them from the module that
// talks to the database does not drag it into the browser bundle.
import type { IdeaSummary, OutlinePoint } from "@/lib/ideas";

/**
 * Where a piece starts.
 *
 * Two panes and no cleverness: the ideas you are holding on the left, and the
 * one you are turning over on the right. The outline is the only structured
 * part, and it is structured only as far as it needs to be — a heading, points
 * under it, and somewhere to keep the quote you already know you want.
 *
 * Like the rest of the Writing desk this never calls a model, and the "make a
 * draft" button does no composing: it lays your own headings and points onto a
 * page and stops. Deciding what to say is the part you kept.
 */

interface Idea extends IdeaSummary {
  outline?: OutlinePoint[];
}

export function Ideas({ initial }: { initial: IdeaSummary[] }) {
  const [ideas, setIdeas] = useState<IdeaSummary[]>(initial);
  const [openId, setOpenId] = useState<number | null>(initial[0]?.id ?? null);
  const [open, setOpen] = useState<(Idea & { outline: OutlinePoint[] }) | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (id: number | null) => {
    if (id === null) return setOpen(null);
    const res = await fetch(`/api/ideas/${id}`);
    if (!res.ok) return setOpen(null);
    setOpen(await res.json());
  }, []);

  useEffect(() => {
    void load(openId);
  }, [openId, load]);

  const act = async (body: unknown) => {
    if (openId === null) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/ideas/${openId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ideas) setIdeas(data.ideas);
      if (data.idea) setOpen(data.idea);
      return data;
    } finally {
      setBusy(false);
    }
  };

  const newIdea = async () => {
    const res = await fetch("/api/ideas", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const data = (await res.json()) as { id: number; ideas: IdeaSummary[] };
    setIdeas(data.ideas);
    setOpenId(data.id);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <div className="space-y-3">
        <Button variant="primary" onClick={newIdea}>
          + New idea
        </Button>

        {ideas.length === 0 && (
          <Card>
            <p className="text-sm text-[var(--color-muted)]">
              Nothing yet. An idea can be one sentence — that is what this is for. It
              stays here, out of the way, until it is worth an outline.
            </p>
          </Card>
        )}

        <ul className="space-y-1.5">
          {ideas.map((i) => (
            <li key={i.id}>
              <button
                onClick={() => setOpenId(i.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                  openId === i.id
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                    : "border-[var(--color-rule)] bg-white hover:border-[var(--color-accent)]"
                }`}
              >
                <span className="block truncate text-sm font-medium" dir={dirOf(i.title)}>
                  {i.title}
                </span>
                <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                  {IDEA_STATES.find((s) => s.id === i.state)?.label ?? i.state}
                  {i.points > 0 && ` · ${i.points} point${i.points === 1 ? "" : "s"}`}
                  {i.evidenced > 0 && ` · ${i.evidenced} with a quote`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {open ? (
        <div className="space-y-4">
          <Card>
            <input
              value={open.title}
              onChange={(e) => setOpen({ ...open, title: e.target.value })}
              onBlur={(e) => void act({ action: "update", title: e.target.value })}
              className="w-full border-0 bg-transparent font-serif text-xl font-semibold outline-none"
              dir={dirOf(open.title)}
              placeholder="What is it?"
            />
            <textarea
              value={open.note}
              onChange={(e) => setOpen({ ...open, note: e.target.value })}
              onBlur={(e) => void act({ action: "update", note: e.target.value })}
              rows={3}
              placeholder="The thought, before you lose it. What is the argument, and why does it matter?"
              className="mt-2 w-full rounded border border-[var(--color-rule)] bg-white p-2 text-sm"
              dir={dirOf(open.note)}
            />

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {IDEA_STATES.map((s) => (
                <button
                  key={s.id}
                  title={s.hint}
                  onClick={() => void act({ action: "update", state: s.id })}
                  className={`rounded-full border px-2.5 py-1 text-xs transition ${
                    open.state === s.id
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                      : "border-[var(--color-rule)] text-[var(--color-muted)] hover:border-[var(--color-accent)]"
                  }`}
                >
                  {s.label}
                </button>
              ))}
              <span className="grow" />
              <button
                onClick={async () => {
                  if (openId === null) return;
                  await fetch(`/api/ideas/${openId}`, { method: "DELETE" })
                    .then((r) => r.json())
                    .then((d: { ideas: IdeaSummary[] }) => {
                      setIdeas(d.ideas);
                      setOpenId(d.ideas[0]?.id ?? null);
                    });
                }}
                className="text-xs text-[var(--color-muted)] underline decoration-dotted hover:text-red-700"
              >
                Delete
              </button>
            </div>
          </Card>

          <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-serif text-lg font-semibold">Outline</h2>
              <span className="text-xs text-[var(--color-muted)]">
                Tab and Shift-Tab change a point&rsquo;s level. Enter adds the next one.
              </span>
            </div>

            {open.outline.length === 0 && (
              <p className="mt-2 text-sm text-[var(--color-muted)]">
                Nothing yet. Start with the sections you think it needs, then put the
                points under them.
              </p>
            )}

            <ul className="mt-3 space-y-1">
              {open.outline.map((p, i) => (
                <PointRow
                  key={p.id}
                  point={p}
                  first={i === 0}
                  last={i === open.outline.length - 1}
                  busy={busy}
                  onChange={(patch) => act({ action: "update-point", pointId: p.id, ...patch })}
                  onMove={(direction) => act({ action: "move-point", pointId: p.id, direction })}
                  onDelete={() => act({ action: "delete-point", pointId: p.id })}
                  onAddAfter={() => act({ action: "add-point", depth: p.depth })}
                />
              ))}
            </ul>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => act({ action: "add-point", depth: 0 })} disabled={busy}>
                + Section
              </Button>
              <Button onClick={() => act({ action: "add-point", depth: 1 })} disabled={busy}>
                + Point
              </Button>
            </div>
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-serif text-lg font-semibold">Turn it into a draft</h2>
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  Lays your sections out as headings and your points as paragraphs, with any
                  quotes you gathered underneath. It writes nothing — the words stay yours.
                </p>
              </div>
              <Button
                variant="primary"
                disabled={busy || open.outline.length === 0}
                onClick={async () => {
                  const data = await act({ action: "to-draft" });
                  if (data?.draftId) window.location.href = `/write?draft=${data.draftId}`;
                }}
              >
                Make a draft
              </Button>
            </div>
            {open.draft_id && (
              <p className="mt-2 text-sm text-[var(--color-muted)]">
                Already became{" "}
                <a href={`/write?draft=${open.draft_id}`} className="text-[var(--color-accent)] hover:underline">
                  {open.draft_title ?? "a draft"}
                </a>
                . Making another leaves that one alone.
              </p>
            )}
          </Card>
        </div>
      ) : (
        <Card>
          <p className="text-sm text-[var(--color-muted)]">
            Pick an idea, or start one.
          </p>
        </Card>
      )}
    </div>
  );
}

function PointRow({
  point,
  first,
  last,
  busy,
  onChange,
  onMove,
  onDelete,
  onAddAfter,
}: {
  point: OutlinePoint;
  first: boolean;
  last: boolean;
  busy: boolean;
  onChange: (patch: { text?: string; depth?: number; quote?: string | null; citation?: string | null }) => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  onAddAfter: () => void;
}) {
  const [text, setText] = useState(point.text);
  const [showQuote, setShowQuote] = useState(Boolean(point.quote));

  useEffect(() => setText(point.text), [point.text, point.id]);

  return (
    <li style={{ marginInlineStart: `${point.depth * 1.5}rem` }}>
      <div className="group flex items-start gap-1.5">
        <span
          className="mt-2 shrink-0 text-xs text-[var(--color-muted)]"
          aria-hidden
        >
          {point.depth === 0 ? "§" : point.depth === 1 ? "•" : "–"}
        </span>

        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text !== point.text && onChange({ text })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (text !== point.text) onChange({ text });
              onAddAfter();
            } else if (e.key === "Tab") {
              e.preventDefault();
              onChange({ depth: point.depth + (e.shiftKey ? -1 : 1) });
            }
          }}
          placeholder={point.depth === 0 ? "A section" : "A point it has to make"}
          dir={dirOf(text)}
          className={`min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 text-sm outline-none hover:border-[var(--color-rule)] focus:border-[var(--color-accent)] focus:bg-white ${
            point.depth === 0 ? "font-medium" : ""
          }`}
        />

        <div className="reveal flex shrink-0 items-center gap-1">
          <button
            onClick={() => setShowQuote((v) => !v)}
            title="Keep a quote with this point"
            className={`px-1 text-xs ${point.quote ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]"} hover:text-[var(--color-accent)]`}
          >
            ❝
          </button>
          <button onClick={() => onMove(-1)} disabled={busy || first} title="Move up" className="px-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)] disabled:opacity-30">
            ↑
          </button>
          <button onClick={() => onMove(1)} disabled={busy || last} title="Move down" className="px-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)] disabled:opacity-30">
            ↓
          </button>
          <button onClick={onDelete} disabled={busy} title="Remove" className="px-1 text-xs text-[var(--color-muted)] hover:text-red-700">
            ×
          </button>
        </div>
      </div>

      {showQuote && (
        <div className="ms-5 mt-1 space-y-1">
          <textarea
            defaultValue={point.quote ?? ""}
            onBlur={(e) => onChange({ quote: e.target.value.trim() || null })}
            rows={2}
            placeholder="A quote you already know belongs here. Paste it; nothing checks it until the draft is fact-checked."
            className="w-full rounded border border-[var(--color-rule)] bg-white p-2 text-xs italic"
            dir={dirOf(point.quote ?? "")}
          />
          <input
            defaultValue={point.citation ?? ""}
            onBlur={(e) => onChange({ citation: e.target.value.trim() || null })}
            placeholder="Where it came from"
            className="w-full rounded border border-[var(--color-rule)] bg-white px-2 py-1 text-xs"
          />
        </div>
      )}
    </li>
  );
}
