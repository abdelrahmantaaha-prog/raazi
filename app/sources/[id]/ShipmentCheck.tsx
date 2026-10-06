"use client";

import Link from "next/link";
import { useState } from "react";
import type { Lookup, ShipmentCheck as Report } from "@/lib/pipeline/shipcheck";
import { Badge, Button } from "../../components/ui";
import { ArticleLink, hostOf } from "../../components/ArticleLink";
import { RunChip } from "../../components/RunChip";
import { dirOf } from "@/lib/dir";
import { relativeDate } from "@/lib/dates";

const STATUS: Record<Lookup["status"], { label: string; tone: "danger" | "ok" | "quiet" | "warn" }> = {
  flag: { label: "to see", tone: "danger" },
  found: { label: "found", tone: "ok" },
  skipped: { label: "not searched", tone: "warn" },
  nothing: { label: "nothing found", tone: "quiet" },
};
const ORDER: Lookup["status"][] = ["flag", "found", "skipped", "nothing"];

/** "Check online" for one shipment, and what the last check found. */
export function ShipmentCheck({
  sourceId,
  shipment,
  report,
}: {
  sourceId: number;
  shipment: number;
  report?: Report;
}) {
  const [run, setRun] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/sources/${sourceId}/shipment-check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shipment }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; runId?: number; run?: { id?: number } };
      if (!res.ok) throw new Error(data.error ?? "The check could not start.");
      setRun(data.runId ?? data.run?.id ?? null);
      setMessage("Looking the parties, codes and route up online. The findings appear here in a few minutes.");
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const lookups = [...(report?.lookups ?? [])].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));

  return (
    <div className="space-y-3 rounded border border-[var(--color-rule)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={start} disabled={busy || run !== null}>
          {busy ? "Starting…" : report ? "Check online again" : "Check online"}
        </Button>
        <span className="text-xs text-[var(--color-muted)]">
          {report
            ? `Checked ${relativeDate(report.checkedAt)}.`
            : "Parties against company registers and sanctions lists, customs codes, numbers, and reporting on the goods and route."}
        </span>
      </div>
      {message && <p className="text-sm">{message}</p>}
      {run && <RunChip runId={run} />}

      {report && (
        <div className="space-y-3">
          {report.overview && (
            <p className="text-sm" dir={dirOf(report.overview)}>
              {report.overview}
            </p>
          )}
          <ul className="space-y-2">
            {lookups.map((l, i) => (
              <li key={i} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS[l.status].tone}>{STATUS[l.status].label}</Badge>
                  <span className="font-medium" dir={dirOf(l.subject)}>
                    {l.subject}
                  </span>
                  <span className="text-xs text-[var(--color-muted)]">{l.kind}</span>
                </div>
                {l.found && (
                  <p className="mt-0.5" dir={dirOf(l.found)}>
                    {l.found}
                  </p>
                )}
                {l.sources.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {l.sources.map((s, n) => (
                      <li key={n}>
                        <ArticleLink href={s.url} className="text-[var(--color-accent)] hover:underline">
                          {s.title || hostOf(s.url)}
                        </ArticleLink>
                        {s.says && <span className="text-[var(--color-muted)]"> — {s.says}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {l.unread ? (
                  <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                    {l.unread} source{l.unread === 1 ? "" : "s"} it named could not be confirmed as read, and
                    {l.unread === 1 ? " was" : " were"} left out.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {report.leads > 0 && (
            <p className="text-sm">
              {report.leads} new lead{report.leads === 1 ? "" : "s"} in the{" "}
              <Link href="/research" className="text-[var(--color-accent)] hover:underline">
                Research inbox
              </Link>
              .
            </p>
          )}
        </div>
      )}
    </div>
  );
}
