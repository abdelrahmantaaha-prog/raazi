"use client";

import { useEffect, useState } from "react";
import { Button, Card } from "../components/ui";
import { reasonLabel } from "@/lib/discard-reasons";
import { dirOf } from "@/lib/dir";

interface Correction {
  id: number;
  entity_name: string;
  quote: string;
  reason: string;
  note: string | null;
  source_title: string | null;
  created_at: string;
}

/**
 * The corrections you told Corpus to apply everywhere.
 *
 * They need a home outside the entry they were raised on, for the obvious
 * reason: a rule that changes what happens across the whole library and can only
 * be found by remembering which passage prompted it is not a rule you can
 * govern. Entry-scoped verdicts stay on their entries, where they belong.
 */
export function CorrectionsCard() {
  const [rows, setRows] = useState<Correction[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/corrections")
      .then((r) => r.json())
      .then((d: { corrections: Correction[] }) => setRows(d.corrections))
      .catch(() => setRows([]));
  }, []);

  const drop = async (id: number) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/corrections?id=${id}`, { method: "DELETE" });
      const data = (await res.json()) as { corrections?: Correction[] };
      if (data.corrections) setRows(data.corrections);
    } finally {
      setBusy(false);
    }
  };

  if (rows === null || rows.length === 0) {
    return (
      <Card>
        <h2 className="font-serif text-lg font-semibold">Standing corrections</h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          None yet. When you discard evidence from an entry you can mark the reason as
          applying library-wide; those rules are listed here, and are given to the
          extractor and to the entry writer on every run.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="font-serif text-lg font-semibold">Standing corrections ({rows.length})</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Given to the model on every extraction and every entry. Removing one also puts the
        passage it was blocking back into the record.
      </p>
      <ul className="mt-3 space-y-3">
        {rows.map((c) => (
          <li key={c.id} className="border-l-2 border-[var(--color-rule)] pl-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
              <span className="font-medium">{reasonLabel(c.reason)}</span>
              <span className="text-[var(--color-muted)]">
                — raised on {c.entity_name}
                {c.source_title ? `, in ${c.source_title}` : ""}
              </span>
            </div>
            {c.note && (
              <p className="mt-1 text-sm" dir={dirOf(c.note)}>
                “{c.note}”
              </p>
            )}
            <p
              className="mt-1 text-xs italic text-[var(--color-muted)] line-through"
              dir={dirOf(c.quote)}
            >
              {c.quote.length > 160 ? `${c.quote.slice(0, 160)}…` : c.quote}
            </p>
            <div className="mt-1">
              <Button variant="ghost" onClick={() => drop(c.id)} disabled={busy}>
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
