"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import type { TagWithCounts } from "@/lib/tags";
import { Button, Card, Empty, inputClass } from "../components/ui";

interface SourceRow {
  id: number;
  title: string;
  author: string | null;
  kind: string;
  chunks: number;
  tagIds: number[];
}

export function TagsManager({ tags, sources }: { tags: TagWithCounts[]; sources: SourceRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [newTag, setNewTag] = useState("");
  const [mergeInto, setMergeInto] = useState<Record<number, string>>({});

  const untagged = sources.filter((s) => s.tagIds.length === 0 && s.chunks > 0);

  const call = async (url: string, init: RequestInit, note?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, init);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "That didn't work.");
      if (note) setMessage(note);
      router.refresh();
      return data;
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Topics</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Topics keep separate research separate without splitting the pedia. An entity is never
          duplicated — it simply carries every topic that applies, so a person who turns up in two
          of your subjects stays one person with one entry, findable under both.
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap gap-2">
          <input
            className={`${inputClass} max-w-xs flex-1`}
            placeholder="New topic — e.g. Egyptian politics"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newTag.trim()) {
                void call("/api/tags", json({ name: newTag }), `Created “${newTag.trim()}”.`);
                setNewTag("");
              }
            }}
          />
          <Button
            variant="primary"
            disabled={busy || !newTag.trim()}
            onClick={() => {
              void call("/api/tags", json({ name: newTag }), `Created “${newTag.trim()}”.`);
              setNewTag("");
            }}
          >
            Add topic
          </Button>

          {untagged.length > 0 && (
            <Button
              disabled={busy}
              onClick={() =>
                call(
                  "/api/tags",
                  json({ action: "fileUntagged" }),
                  `Queued ${untagged.length} source${untagged.length === 1 ? "" : "s"} for filing — watch the Library.`
                )
              }
            >
              File {untagged.length} unfiled source{untagged.length === 1 ? "" : "s"} with AI
            </Button>
          )}
        </div>
        {message && <p className="mt-3 text-sm text-[var(--color-accent)]">{message}</p>}
      </Card>

      {tags.length === 0 ? (
        <Empty
          title="No topics yet"
          hint="Add one above, or just add a source — each new source is filed automatically."
        />
      ) : (
        <div className="space-y-3">
          {tags.map((t) => (
            <Card key={t.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: t.color ?? "var(--color-accent)" }}
                    />
                    <Link
                      href={`/pedia?tag=${t.id}`}
                      className="font-medium hover:text-[var(--color-accent)]"
                    >
                      {t.name}
                    </Link>
                  </div>
                  {t.description && (
                    <p className="mt-1 text-sm text-[var(--color-muted)]">{t.description}</p>
                  )}
                  <p className="mt-1 text-sm text-[var(--color-muted)]">
                    {t.sources} source{t.sources === 1 ? "" : "s"} · {t.entities} entit
                    {t.entities === 1 ? "y" : "ies"}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="rounded border border-[var(--color-rule)] bg-white px-2 py-1.5 text-sm"
                    value={mergeInto[t.id] ?? ""}
                    onChange={(e) => setMergeInto({ ...mergeInto, [t.id]: e.target.value })}
                  >
                    <option value="">Merge another into this…</option>
                    {tags
                      .filter((o) => o.id !== t.id)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                  </select>
                  {mergeInto[t.id] && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        void call(
                          `/api/tags/${t.id}`,
                          json({ action: "merge", otherId: Number(mergeInto[t.id]) }),
                          "Merged."
                        );
                        setMergeInto({ ...mergeInto, [t.id]: "" });
                      }}
                    >
                      Merge
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      const name = prompt("Rename topic:", t.name);
                      if (name?.trim()) {
                        void call(`/api/tags/${t.id}`, json({ action: "rename", name }), "Renamed.");
                      }
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          `Delete the topic “${t.name}”?\n\nOnly the label goes. Your sources, entities and quotes are untouched.`
                        )
                      ) {
                        void call(`/api/tags/${t.id}`, { method: "DELETE" }, "Topic deleted.");
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="font-serif text-lg font-semibold">Which topic each source is filed under</h2>
        {sources.length === 0 ? (
          <Empty title="No sources yet" />
        ) : (
          <div className="divide-y divide-[var(--color-rule)] rounded-lg border border-[var(--color-rule)] bg-white">
            {sources.map((s) => (
              <SourceRowEditor key={s.id} source={s} tags={tags} onDone={() => router.refresh()} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SourceRowEditor({
  source,
  tags,
  onDone,
}: {
  source: SourceRow;
  tags: TagWithCounts[];
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<number[]>(source.tagIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (tagId: number) => {
    const before = selected;
    const next = selected.includes(tagId)
      ? selected.filter((x) => x !== tagId)
      : [...selected, tagId];
    setSelected(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/sources/${source.id}/tags`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tagIds: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Could not change that.");
      }
      onDone();
    } catch (err) {
      // Back to what the server still has, and say why.
      setSelected(before);
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <Link
        href={`/sources/${source.id}`}
        className="min-w-0 flex-1 truncate font-medium hover:text-[var(--color-accent)]"
      >
        {source.title}
        <span className="ml-2 text-sm font-normal text-[var(--color-muted)]">
          {source.author ?? source.kind.toUpperCase()}
        </span>
      </Link>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t) => {
          const on = selected.includes(t.id);
          return (
            <button
              key={t.id}
              disabled={saving}
              onClick={() => toggle(t.id)}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                on ? "text-white" : "bg-white text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
              }`}
              style={
                on
                  ? { backgroundColor: t.color ?? "var(--color-accent)", borderColor: t.color ?? "var(--color-accent)" }
                  : { borderColor: "var(--color-rule)" }
              }
            >
              {t.name}
            </button>
          );
        })}
        {selected.length === 0 && (
          <span className="text-xs text-[var(--color-muted)]">unfiled</span>
        )}
      </div>
      {error && <span className="w-full text-xs text-red-700">{error}</span>}
    </div>
  );
}
