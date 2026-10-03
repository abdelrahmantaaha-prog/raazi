"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { FolderFile, FolderRow } from "@/lib/folders";
import { Badge, Button, Card } from "../../components/ui";
import { RunChip } from "../../components/RunChip";

type Row = FolderFile & { as: string | null };

const STATE: Record<string, { label: string; tone: "quiet" | "warn" | "ok" | "danger" | "running" }> = {
  waiting: { label: "waiting", tone: "warn" },
  queued: { label: "being read", tone: "running" },
  added: { label: "read", tone: "ok" },
  skipped: { label: "left out", tone: "quiet" },
  unsupported: { label: "can't read this kind", tone: "quiet" },
  failed: { label: "failed", tone: "danger" },
};

const size = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

/**
 * One folder: its files as they were laid out, what each is, and whether it
 * has been read. Read all reads every waiting file; a file you leave out stays
 * listed but is passed over. Nothing here is read until you press a button.
 */
export function FolderView({ folder, files }: { folder: FolderRow; files: Row[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [run, setRun] = useState<number | null>(null);
  const [name, setName] = useState(folder.name);
  const [renaming, setRenaming] = useState(false);

  // Grouped by subfolder, the folder's own files first.
  const groups = useMemo(() => {
    const by = new Map<string, Row[]>();
    for (const f of files) {
      const dir = f.rel_path.includes("/") ? f.rel_path.slice(0, f.rel_path.lastIndexOf("/")) : "";
      by.set(dir, [...(by.get(dir) ?? []), f]);
    }
    return [...by.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  }, [files]);

  const waiting = files.filter((f) => f.state === "waiting").length;

  async function call(body: unknown, note?: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/folders/${folder.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; runId?: number; queued?: number };
      if (!res.ok) throw new Error(data.error ?? "That did not work.");
      if (data.runId) {
        setRun(data.runId);
        setMessage(`Reading ${data.queued} file${data.queued === 1 ? "" : "s"}. Each becomes a source in your Library as it is read.`);
      } else if (note) setMessage(note);
      router.refresh();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Remove the folder “${folder.name}”? Files not yet read are deleted from Corpus; sources already read from it stay in your Library.`)) return;
    setBusy(true);
    const res = await fetch(`/api/folders/${folder.id}`, { method: "DELETE" });
    if (res.ok) router.push("/folders");
    else {
      setBusy(false);
      setMessage("Could not remove it.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-[var(--color-muted)]">
            <Link href="/folders" className="hover:text-[var(--color-ink)]">Folders</Link> /
          </p>
          {renaming ? (
            <form
              className="mt-1 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setRenaming(false);
                void call({ action: "rename", name });
              }}
            >
              <input
                className="rounded border border-[var(--color-rule)] px-2 py-1 font-serif text-xl"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              <Button variant="primary">Save</Button>
            </form>
          ) : (
            <h1 className="break-words font-serif text-2xl font-semibold">
              📁 {folder.name}{" "}
              <button onClick={() => setRenaming(true)} className="text-sm font-normal text-[var(--color-muted)] hover:underline">
                rename
              </button>
            </h1>
          )}
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {folder.files} file{folder.files === 1 ? "" : "s"} from a {folder.origin} · {folder.added} read ·{" "}
            {folder.waiting} waiting
            {folder.unsupported ? ` · ${folder.unsupported} Corpus cannot read yet` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => call({ action: "read" })} disabled={busy || waiting === 0}>
            Read all waiting ({waiting})
          </Button>
          <Button variant="danger" onClick={remove} disabled={busy}>
            Remove folder
          </Button>
        </div>
      </div>

      {message && (
        <p className="flex flex-wrap items-center gap-3 rounded border border-[var(--color-rule)] bg-white px-3 py-2 text-sm">
          <span>{message}</span>
          {run && <RunChip runId={run} />}
        </p>
      )}

      {groups.map(([dir, rows]) => (
        <Card key={dir || "."}>
          {dir && <p className="mb-2 font-mono text-xs text-[var(--color-muted)]">📂 {dir}/</p>}
          <ul className="divide-y divide-[var(--color-rule)]">
            {rows.map((f) => {
              const file = f.rel_path.split("/").pop();
              const st = STATE[f.state] ?? { label: f.state, tone: "quiet" as const };
              return (
                <li key={f.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="min-w-0 flex-1 break-words" dir="auto">
                    {f.source_id ? (
                      <Link href={`/sources/${f.source_id}`} className="text-[var(--color-accent)] hover:underline">
                        {file}
                      </Link>
                    ) : (
                      file
                    )}
                  </span>
                  <span className="text-xs text-[var(--color-muted)]">{size(f.size)}</span>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  {(f.state === "waiting" || f.state === "failed") && (
                    <>
                      <Button onClick={() => call({ action: "read", fileIds: [f.id] })} disabled={busy}>
                        {f.state === "failed" ? "Try again" : "Read"}
                      </Button>
                      {f.state === "waiting" && (
                        <Button variant="ghost" onClick={() => call({ action: "skip", fileId: f.id })} disabled={busy}>
                          Leave out
                        </Button>
                      )}
                    </>
                  )}
                  {f.state === "skipped" && (
                    <Button variant="ghost" onClick={() => call({ action: "unskip", fileId: f.id })} disabled={busy}>
                      Put back
                    </Button>
                  )}
                  {f.error && <span className="w-full text-xs text-red-700">{f.error}</span>}
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
    </div>
  );
}
