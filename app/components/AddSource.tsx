"use client";

import { useRef, useState } from "react";
import { Button, Card, Field, inputClass } from "./ui";

type Mode = "file" | "url" | "text";

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "file", label: "File", hint: "PDF, EPUB, Markdown, plain text, audio or video" },
  { id: "url", label: "Link", hint: "An article URL, or a YouTube link to transcribe" },
  { id: "text", label: "Paste", hint: "Notes, an excerpt, anything you have as text" },
];

export function AddSource({ onAdded }: { onAdded: () => void }) {
  const [mode, setMode] = useState<Mode>("file");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");

  const done = (message: string) => {
    setNote(message);
    setTitle("");
    setAuthor("");
    setUrl("");
    setText("");
    if (fileRef.current) fileRef.current.value = "";
    onAdded();
  };

  const post = async (body: BodyInit, headers?: HeadersInit) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/sources", { method: "POST", body, headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      done(data.note ?? "Added.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    for (const file of list) {
      const form = new FormData();
      form.append("file", file);
      // Only apply the typed title when adding a single file.
      if (list.length === 1 && title.trim()) form.append("title", title.trim());
      if (author.trim()) form.append("author", author.trim());
      await post(form);
    }
  };

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center gap-1">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => {
              setMode(m.id);
              setError(null);
              setNote(null);
            }}
            className={`rounded px-3 py-1.5 text-sm font-medium transition ${
              mode === m.id
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
            }`}
          >
            {m.label}
          </button>
        ))}
        <span className="ml-2 text-sm text-[var(--color-muted)]">
          {MODES.find((m) => m.id === mode)!.hint}
        </span>
      </div>

      {mode === "file" && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length) void submitFiles(e.dataTransfer.files);
          }}
          onClick={() => fileRef.current?.click()}
          className={`cursor-pointer rounded-lg border-2 border-dashed px-6 py-10 text-center transition ${
            dragging
              ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
              : "border-[var(--color-rule)] hover:border-[var(--color-accent)]"
          }`}
        >
          <p className="font-medium">{busy ? "Reading…" : "Drop files here, or click to choose"}</p>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            A born-digital PDF costs nothing to read; scanned pages are sent for OCR only where needed.
          </p>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && void submitFiles(e.target.files)}
          />
        </div>
      )}

      {mode === "url" && (
        <div className="flex flex-wrap gap-3">
          <div className="min-w-[18rem] flex-1">
            <Field label="Address">
              <input
                className={inputClass}
                placeholder="https://… or a YouTube link"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex items-end">
            <Button
              variant="primary"
              disabled={busy || !url.trim()}
              onClick={() =>
                post(JSON.stringify({ url, title: title.trim() || undefined }), {
                  "content-type": "application/json",
                })
              }
            >
              {busy ? "Fetching…" : "Add"}
            </Button>
          </div>
        </div>
      )}

      {mode === "text" && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-3">
            <div className="min-w-[14rem] flex-1">
              <Field label="Title">
                <input
                  className={inputClass}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What is this?"
                />
              </Field>
            </div>
            <div className="min-w-[14rem] flex-1">
              <Field label="Author" hint="Optional — used in citations">
                <input className={inputClass} value={author} onChange={(e) => setAuthor(e.target.value)} />
              </Field>
            </div>
          </div>
          <Field label="Text">
            <textarea
              className={`${inputClass} min-h-40 font-mono text-xs`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste the passage, chapter, or notes."
            />
          </Field>
          <Button
            variant="primary"
            disabled={busy || !text.trim() || !title.trim()}
            onClick={() =>
              post(JSON.stringify({ text, title, author: author || undefined }), {
                "content-type": "application/json",
              })
            }
          >
            {busy ? "Adding…" : "Add"}
          </Button>
        </div>
      )}

      {mode === "file" && (
        <div className="mt-3 flex flex-wrap gap-3">
          <div className="min-w-[14rem] flex-1">
            <Field label="Title" hint="Optional — otherwise taken from the file">
              <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </div>
          <div className="min-w-[14rem] flex-1">
            <Field label="Author" hint="Optional — used in citations">
              <input className={inputClass} value={author} onChange={(e) => setAuthor(e.target.value)} />
            </Field>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      {note && <p className="mt-3 text-sm text-emerald-700">{note}</p>}
    </Card>
  );
}
