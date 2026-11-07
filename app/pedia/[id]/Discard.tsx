"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DISCARD_REASONS, type DiscardReason, type DiscardScope } from "@/lib/discard-reasons";
import { dirOf } from "@/lib/dir";
import { Button } from "../../components/ui";

/**
 * Rejecting a passage, and saying why.
 *
 * The form asks for a reason before it will do anything, which is the whole
 * point of it: a discard with no reason removes one passage, and a discard with
 * a reason also changes what the next pass is told. Making the reason optional
 * would have meant almost every discard arriving without one, and the feature
 * quietly degrading into a delete button.
 */
export function DiscardButton({
  mentionId,
  onDone,
}: {
  mentionId: number;
  onDone?: (message: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<DiscardReason | null>(null);
  const [note, setNote] = useState("");
  const [scope, setScope] = useState<DiscardScope>("entity");
  const [busy, setBusy] = useState(false);

  const submit = async (rewrite: boolean) => {
    if (!reason) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/mentions/${mentionId}/discard`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason, note: note.trim() || undefined, scope, rewrite }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed.");
      setOpen(false);
      setReason(null);
      setNote("");
      onDone?.(
        rewrite
          ? "Discarded. Rewriting the entry without it."
          : "Discarded. The entry still cites it until you rewrite."
      );
      router.refresh();
    } catch (err) {
      onDone?.((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-[var(--color-muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent)]"
      >
        Discard
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-[var(--color-rule)] bg-[var(--color-paper)] p-3">
      <p className="text-xs font-medium">Why is this not evidence?</p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {DISCARD_REASONS.map((r) => (
          <button
            key={r.id}
            title={r.hint}
            onClick={() => setReason(r.id)}
            className={`rounded-full border px-2.5 py-1 text-xs transition ${
              reason === r.id
                ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                : "border-[var(--color-rule)] text-[var(--color-muted)] hover:border-[var(--color-accent)]"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {reason && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          {DISCARD_REASONS.find((r) => r.id === reason)!.hint}
        </p>
      )}

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="What went wrong, in your words. This is what Raazi is told next time."
        className="mt-2 w-full rounded border border-[var(--color-rule)] bg-white p-2 text-sm"
        dir={dirOf(note)}
      />

      <label className="mt-2 flex items-start gap-2 text-xs text-[var(--color-muted)]">
        <input
          type="checkbox"
          checked={scope === "library"}
          onChange={(e) => setScope(e.target.checked ? "library" : "entity")}
          className="mt-0.5"
        />
        <span>
          Apply this correction across the whole library, not just here. Use it for a
          habit you keep seeing; a note about one subject is better left on that subject.
        </span>
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => submit(true)} disabled={!reason || busy}>
          {busy ? "Working…" : "Discard and rewrite the entry"}
        </Button>
        <Button variant="ghost" onClick={() => submit(false)} disabled={!reason || busy}>
          Just discard
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
      {!reason && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">Pick a reason to continue.</p>
      )}
    </div>
  );
}

/** Putting one back. */
export function RestoreButton({
  mentionId,
  onDone,
}: {
  mentionId: number;
  onDone?: (message: string) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetch(`/api/mentions/${mentionId}/discard?rewrite=1`, {
            method: "DELETE",
          });
          if (!res.ok) throw new Error("Failed.");
          onDone?.("Restored. Rewriting the entry with it.");
          router.refresh();
        } catch (err) {
          onDone?.((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
      className="text-xs text-[var(--color-muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent)]"
    >
      {busy ? "…" : "Put it back"}
    </button>
  );
}
