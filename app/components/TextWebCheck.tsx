"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { TextTarget, WebReport } from "@/lib/web-checks";
import { Button } from "./ui";
import { RunChip } from "./RunChip";
import { WebCheckReport } from "../pedia/[id]/WebCheck";

const WHAT: Record<TextTarget, string> = { draft: "draft", source: "source" };

/**
 * "Check on the web" for a draft or a source, and the last check's verdicts.
 * The same check an entry gets: its main claims against what the web and the
 * research tools say. Nothing is edited.
 */
export function TextWebCheck({
  target,
  id,
  report,
  changedAt,
  onDone,
  disabled,
}: {
  target: TextTarget;
  id: number;
  report?: WebReport | null;
  /** When the text last changed, so an older check says it is out of date. */
  changedAt?: string;
  /** Called when the check finishes; the page refreshes by default. */
  onDone?: () => void;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [run, setRun] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/${target === "draft" ? "drafts" : "sources"}/${id}/webcheck`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; runId?: number };
      if (!res.ok && res.status !== 202) throw new Error(data.error ?? "The check could not start.");
      setRun(data.runId ?? null);
      setMessage(`Checking the ${WHAT[target]}'s main claims on the web. The verdicts appear here in a few minutes.`);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finished = () => {
    setRun(null);
    setMessage(null);
    if (onDone) onDone();
    else router.refresh();
  };

  return (
    <div className="space-y-2">
      {!report && (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={start} disabled={disabled || busy || run !== null}>
            {busy ? "Starting…" : "Check on the web"}
          </Button>
          <span className="text-xs text-[var(--color-muted)]">
            Its main claims — names, dates, figures, events — against the web, registers and archives. Nothing is changed.
          </span>
        </div>
      )}
      {message && <p className="text-sm">{message}</p>}
      {run && <RunChip runId={run} onDone={finished} />}
      {report && (
        <WebCheckReport report={report} what={WHAT[target]} writtenAt={changedAt} onRecheck={start} busy={busy || run !== null} />
      )}
    </div>
  );
}
