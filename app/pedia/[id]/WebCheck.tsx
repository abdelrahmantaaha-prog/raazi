"use client";

import { useEffect, useRef, useState } from "react";
import type { WebReport, WebVerdict } from "@/lib/web-checks";
import { Badge, Button } from "../../components/ui";
import { dirOf } from "@/lib/dir";
import { formatDateTime, parseDate, relativeDate } from "@/lib/dates";

const VERDICT: Record<WebVerdict, { label: string; tone: "ok" | "warn" | "danger" | "quiet" }> = {
  confirmed: { label: "confirmed", tone: "ok" },
  partly: { label: "partly", tone: "warn" },
  disputed: { label: "disputed", tone: "danger" },
  not_found: { label: "not found", tone: "quiet" },
};

/**
 * Asks for the entry, or its connections, to be checked against the web.
 * A menu rather than two buttons: the header row is full, and which of the two
 * you want is a choice made once, at the moment of asking.
 */
export function WebCheckButton({
  hasEntry,
  connections,
  disabled,
  onCheck,
}: {
  hasEntry: boolean;
  connections: number;
  disabled?: boolean;
  onCheck: (scope: "entry" | "connections") => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const pick = (scope: "entry" | "connections") => {
    setOpen(false);
    onCheck(scope);
  };

  return (
    <div ref={ref} className="relative">
      <Button onClick={() => setOpen((o) => !o)} disabled={disabled || (!hasEntry && connections === 0)}>
        Check on the web ▾
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-[var(--color-rule)] bg-white p-1 text-sm shadow-lg">
          <button
            onClick={() => pick("entry")}
            disabled={!hasEntry}
            className="block w-full rounded px-3 py-2 text-left hover:bg-[var(--color-accent-soft)] disabled:opacity-40"
          >
            <span className="font-medium">The entry</span>
            <span className="block text-xs text-[var(--color-muted)]">
              Its main claims — names, dates, figures, events — against what the web says.
            </span>
          </button>
          <button
            onClick={() => pick("connections")}
            disabled={connections === 0}
            className="block w-full rounded px-3 py-2 text-left hover:bg-[var(--color-accent-soft)] disabled:opacity-40"
          >
            <span className="font-medium">Its connections ({connections})</span>
            <span className="block text-xs text-[var(--color-muted)]">
              Whether each tie to another subject is real, and the tie stated.
            </span>
          </button>
          <p className="px-3 py-2 text-xs text-[var(--color-muted)]">
            Uses Claude on your plan with web search and the research tools — registers,
            archives, court and company records, public posts, ship lookups. Takes a few
            minutes. Nothing is changed: the verdicts appear beside the text, and anything new
            it finds waits in the Research inbox.
          </p>
        </div>
      )}
    </div>
  );
}

/** What the web said, kept beside the entry or the connections it is about. */
export function WebCheckReport({
  report,
  writtenAt,
  onRecheck,
  busy,
  disabled,
  what: named,
}: {
  report: WebReport;
  /** What was checked, when it is not a subject's entry: "draft", "source". */
  what?: string;
  /** When the entry was last written, to say if the check predates it. */
  writtenAt?: string;
  onRecheck: () => void;
  /** A check is starting or under way. */
  busy?: boolean;
  /** There is nothing to check, e.g. the draft has been emptied. */
  disabled?: boolean;
}) {
  const counts = (Object.keys(VERDICT) as WebVerdict[])
    .map((v) => [v, report.findings.filter((f) => f.verdict === v).length] as const)
    .filter(([, n]) => n > 0);
  const written = parseDate(writtenAt);
  const checked = parseDate(report.checkedAt);
  const what = report.scope === "connections" ? "connections" : named ?? "entry";
  const stale = report.scope !== "connections" && written && checked && written > checked;

  return (
    <details className="rounded-lg border border-[var(--color-rule)] bg-white" open={report.findings.some((f) => f.verdict === "disputed")}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 text-sm font-medium">
        <span>
          Checked on the web: {report.findings.length} {report.scope === "connections" ? "connection" : "claim"}
          {report.findings.length === 1 ? "" : "s"}
        </span>
        {counts.map(([v, n]) => (
          <Badge key={v} tone={VERDICT[v].tone}>
            {n} {VERDICT[v].label}
          </Badge>
        ))}
      </summary>
      <div className="space-y-3 border-t border-[var(--color-rule)] px-4 py-3">
        {report.overview && (
          <p className="text-sm" dir={dirOf(report.overview)}>
            {report.overview}
          </p>
        )}
        {stale && (
          <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
            The {what} has changed since this check. Check again to see how the new text holds up.
          </p>
        )}
        {report.partial && <p className="text-xs text-[var(--color-muted)]">{report.partial}</p>}
        <ul className="space-y-3">
          {report.findings.map((f, i) => (
            <li key={i} className="border-l-2 border-[var(--color-rule)] pl-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <Badge tone={VERDICT[f.verdict]?.tone ?? "quiet"}>{VERDICT[f.verdict]?.label ?? f.verdict}</Badge>
                <p className="text-sm" dir={dirOf(f.claim)}>
                  {f.claim}
                </p>
              </div>
              {f.note && (
                <p className="mt-1 text-xs text-[var(--color-muted)]" dir={dirOf(f.note)}>
                  {f.note}
                </p>
              )}
              {f.sources.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {f.sources.map((s, j) => (
                    <li key={j} className="text-xs">
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="font-medium text-[var(--color-accent)] hover:underline"
                      >
                        {s.title || hostOf(s.url)}
                      </a>
                      <span className="text-[var(--color-muted)]"> · {hostOf(s.url)}</span>
                      {s.says && (
                        <span className="block text-[var(--color-muted)]" dir={dirOf(s.says)}>
                          “{s.says}”
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {f.unread ? (
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {f.unread} other page{f.unread === 1 ? "" : "s"} named for this {f.unread === 1 ? "was" : "were"} not
                  among those the search actually found, so {f.unread === 1 ? "it is" : "they are"} left out.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
        {report.leads && report.leads.length > 0 && (
          <div className="border-t border-[var(--color-rule)] pt-3">
            <p className="text-sm font-medium">Found along the way</p>
            <ul className="mt-1 space-y-1">
              {report.leads.map((l, i) => (
                <li key={i} className="text-xs">
                  <a href={l.url} target="_blank" rel="noreferrer noopener" className="font-medium text-[var(--color-accent)] hover:underline">
                    {l.title || hostOf(l.url)}
                  </a>
                  <span className="text-[var(--color-muted)]"> · {hostOf(l.url)}</span>
                  <span className="block text-[var(--color-muted)]" dir={dirOf(l.why)}>
                    {l.why}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="flex flex-wrap items-center gap-3 border-t border-[var(--color-rule)] pt-3 text-xs text-[var(--color-muted)]">
          <span title={formatDateTime(report.checkedAt)}>Checked {relativeDate(report.checkedAt)}.</span>
          <span>
            “Not found” means the search turned up nothing either way — not that the {what} is wrong.
          </span>
          <button
            onClick={onRecheck}
            disabled={busy || disabled}
            className="font-medium underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
          >
            {busy ? "Checking…" : "Check again"}
          </button>
        </p>
      </div>
    </details>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
