"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "../components/ui";

interface Discipline {
  id: string;
  name: string;
  createdAt: string;
}

/**
 * More than one subject, each with its own library.
 *
 * A discipline is not a filter over one library — it is a separate one, with
 * its own sources, entities, entries, feeds, inbox, briefs and drafts. That
 * is what makes it impossible for two subjects to bleed into each other:
 * there is nothing to filter, because the other discipline is not in the
 * database being read.
 *
 * Opening another one restarts the server, which takes a second or two, and
 * is the point rather than a cost: the process that was working in one
 * library is gone before the next is opened, so nothing of it can carry over.
 */
export function Disciplines() {
  const router = useRouter();
  const [list, setList] = useState<Discipline[]>([]);
  const [active, setActive] = useState("");
  const [pinned, setPinned] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (d: { disciplines?: Discipline[]; active?: string; pinned?: boolean }) => {
    setList(d.disciplines ?? []);
    setActive(d.active ?? "");
    setPinned(Boolean(d.pinned));
  };

  useEffect(() => {
    void fetch("/api/disciplines", { cache: "no-store" })
      .then((r) => r.json())
      .then(load)
      .catch(() => undefined);
  }, []);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/disciplines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "That did not work.");
      load(data);
      // The rail names the open discipline, and a layout is not re-rendered by
      // moving between pages — so a rename, or a second discipline appearing,
      // stayed off it until a reload. Not after "open": that server is on its
      // way out, and the page reloads itself once the next one is up.
      if (body.action !== "open") router.refresh();
      return data;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: string) => {
    const data = await send({ action: "open", id });
    if (!data?.restarting) return;
    setNote(`Opening ${data.opening}… the page comes back on its own.`);
    // The server is on its way out; wait for the one the launcher starts in
    // its place, then show the discipline that is now open.
    const waitForIt = async () => {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const res = await fetch("/api/disciplines", { cache: "no-store" });
          if (res.ok) {
            const fresh = await res.json();
            if (fresh.active === id) {
              window.location.reload();
              return;
            }
          }
        } catch {
          /* still down */
        }
      }
      setNote("It is taking longer than expected — reload the page in a moment.");
    };
    void waitForIt();
  };

  if (pinned) return null;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-serif text-lg font-semibold">Disciplines</h2>
        <p className="mt-0.5 text-sm text-[var(--color-muted)]">
          A separate library per subject, with its own sources, entries, feeds and briefs. Only the AI
          settings are shared. Opening another one restarts Raazi for a moment.
        </p>
      </div>

      <ul className="divide-y divide-[var(--color-rule)] rounded-lg border border-[var(--color-rule)] bg-white">
        {list.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
              {d.name}
              {d.id === active && (
                <span className="ms-2 rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-xs text-[var(--color-accent)]">
                  open
                </span>
              )}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const next = prompt("What should this discipline be called?", d.name);
                if (next && next !== d.name) void send({ action: "rename", id: d.id, name: next });
              }}
              className="text-xs text-[var(--color-muted)] hover:underline"
            >
              Rename
            </button>
            {d.id !== active && (
              <>
                <Button variant="ghost" disabled={busy} onClick={() => void open(d.id)}>
                  Open
                </Button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Take “${d.name}” off this list?\n\nIts library stays on disk — only the entry here goes.`)) {
                      void send({ action: "forget", id: d.id });
                    }
                  }}
                  className="text-xs text-[var(--color-muted)] hover:text-red-700"
                >
                  Remove
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      {adding ? (
        <div className="flex flex-wrap gap-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAdding(false);
            }}
            placeholder="Islamic history, say, or Egyptian politics"
            aria-label="What the discipline is called"
            className="min-w-0 flex-1 rounded border border-[var(--color-rule)] bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
          />
          <Button
            variant="primary"
            disabled={busy || !name.trim()}
            onClick={async () => {
              const made = await send({ action: "add", name });
              if (made) {
                setName("");
                setAdding(false);
                setNote(`“${name.trim()}” is ready — open it to start filling it.`);
              }
            }}
          >
            Start it
          </Button>
          <Button onClick={() => setAdding(false)}>Never mind</Button>
        </div>
      ) : (
        <Button onClick={() => setAdding(true)}>Add a discipline</Button>
      )}

      {note && <p className="text-sm text-[var(--color-muted)]">{note}</p>}
      {error && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
      )}
    </section>
  );
}
