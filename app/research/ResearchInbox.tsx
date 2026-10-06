"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { ResearchFind } from "@/lib/research/finds";
import { Badge, Button, Card, Empty } from "../components/ui";
import { dirOf } from "@/lib/dir";
import { relativeDate } from "@/lib/dates";

const KIND: Record<ResearchFind["kind"], string> = {
  source: "page",
  record: "record",
  post: "public post",
  shipment: "shipment",
};

/**
 * The Research inbox: what web checks turned up along the way.
 *
 * Kept apart from the news inbox on purpose. The news inbox is what your feeds
 * brought in; this is what was looked for, about one subject at a time, so it
 * is grouped by subject. Nothing here is in the library: Keep adds a page as a
 * source, read like any other, and only then can an entry cite it.
 */
export function ResearchInbox({
  finds,
  counts,
  show,
}: {
  finds: ResearchFind[];
  counts: Record<string, number>;
  show: "new" | "kept" | "dismissed";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});

  const bySubject = useMemo(() => {
    const groups = new Map<number, ResearchFind[]>();
    for (const f of finds) groups.set(f.entity_id, [...(groups.get(f.entity_id) ?? []), f]);
    return [...groups.values()];
  }, [finds]);

  async function act(f: ResearchFind, action: "keep" | "dismiss" | "restore") {
    setBusy(f.id);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: f.id, action }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; note?: string };
      if (!res.ok) throw new Error(data.error ?? "That did not work.");
      if (data.note) setNotes((n) => ({ ...n, [f.id]: data.note! }));
      router.refresh();
    } catch (err) {
      setNotes((n) => ({ ...n, [f.id]: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Research inbox</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Pages, records, public posts and shipments that “Check on the web” found about your
          subjects and the library does not have yet. Keep one to add it as a source; it is
          then read like anything else you add. Your news inbox is separate.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        {(["new", "kept", "dismissed"] as const).map((s) => (
          <Link
            key={s}
            href={s === "new" ? "/research" : `/research?show=${s}`}
            className={`rounded-full border px-3 py-1 ${
              show === s
                ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                : "border-[var(--color-rule)] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            }`}
          >
            {s === "new" ? "Waiting" : s === "kept" ? "Kept" : "Dismissed"} ({counts[s] ?? 0})
          </Link>
        ))}
      </div>

      {finds.length === 0 ? (
        <Empty
          title={show === "new" ? "Nothing waiting." : show === "kept" ? "Nothing kept yet." : "Nothing dismissed."}
          hint={
            show === "new"
              ? "Open an entry and press “Check on the web”. Anything it finds that the library lacks lands here."
              : undefined
          }
        />
      ) : (
        bySubject.map((group) => (
          <Card key={group[0].entity_id}>
            <Link href={`/pedia/${group[0].entity_id}`} className="font-serif text-lg font-semibold hover:text-[var(--color-accent)]">
              {group[0].entity_name}
            </Link>
            <ul className="mt-3 space-y-4">
              {group.map((f) => (
                <li key={f.id} className="border-l-2 border-[var(--color-rule)] pl-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={f.kind === "shipment" ? "warn" : "neutral"}>{KIND[f.kind] ?? f.kind}</Badge>
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="min-w-0 break-words font-medium text-[var(--color-accent)] hover:underline"
                      dir={dirOf(f.title ?? f.url)}
                    >
                      {f.title || f.url}
                    </a>
                    <span className="text-xs text-[var(--color-muted)]">{hostOf(f.url)}</span>
                  </div>
                  <p className="mt-1 text-sm" dir={dirOf(f.why)}>
                    {f.why}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
                    <span>
                      Found {relativeDate(f.created_at)} checking the{" "}
                      {f.scope === "connections" ? "connections" : f.scope === "shipment" ? "shipment" : "entry"}
                    </span>
                    {show === "new" && (
                      <>
                        <Button onClick={() => act(f, "keep")} disabled={busy === f.id} variant="primary">
                          {f.kind === "shipment" ? "Done" : "Keep as a source"}
                        </Button>
                        <Button onClick={() => act(f, "dismiss")} disabled={busy === f.id}>
                          Dismiss
                        </Button>
                      </>
                    )}
                    {show === "kept" && f.source_id && (
                      <Link href={`/sources/${f.source_id}`} className="text-[var(--color-accent)] hover:underline">
                        Open the source
                      </Link>
                    )}
                    {show === "dismissed" && (
                      <Button onClick={() => act(f, "restore")} disabled={busy === f.id}>
                        Bring back
                      </Button>
                    )}
                    {f.kind === "shipment" && show === "new" && (
                      <span>Tracking pages need a browser — open the link to look it up.</span>
                    )}
                  </div>
                  {notes[f.id] && <p className="mt-1 text-xs text-[var(--color-muted)]">{notes[f.id]}</p>}
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
