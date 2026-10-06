"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, inputClass } from "../components/ui";

interface Service {
  id: string;
  label: string;
  adds: string;
  signUp: string;
  needed: "required" | "better";
  hint?: string;
  set: boolean;
  tail: string | null;
}

/**
 * Keys for the research tools a web check can use. Most of the toolkit needs
 * none — Wikidata, the news archive, papers, the Wayback Machine, SEC filings,
 * court records, Bluesky, Mastodon, Telegram, the ship register — so the card
 * says so first and lists only the services that want a key.
 */
export function ResearchToolsCard() {
  const [services, setServices] = useState<Service[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/research/keys");
    if (res.ok) setServices(((await res.json()) as { services: Service[] }).services);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(id: string, value: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/research/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, value }),
      });
      const data = (await res.json().catch(() => ({}))) as { services?: Service[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not save.");
      setServices(data.services ?? null);
      setDraft((d) => ({ ...d, [id]: "" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <h2 className="font-serif text-lg font-semibold">Research tools</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        What “Check on the web” can use besides web search. These work with no key: Wikidata,
        the worldwide news archive, academic papers, the Wayback Machine, US SEC filings, US
        court records, public Bluesky, Mastodon and Telegram channels, the ship register, the
        ICIJ Offshore Leaks, Ukraine&rsquo;s catalogue of foreign parts in Russian weapons, Conflict
        Armament Research, UN panel-of-experts reports, the SIPRI arms-transfer register, UN
        Comtrade trade figures and the global LEI company register.
        The services below need a free key from their own site; a tool without its key is
        simply left out of the check.
      </p>
      {!services ? (
        <p className="mt-3 text-sm text-[var(--color-muted)]">Loading…</p>
      ) : (
        <ul className="mt-4 space-y-4">
          {services.map((s) => (
            <li key={s.id} className="border-t border-[var(--color-rule)] pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.label}</span>
                {s.set ? (
                  <Badge tone="ok">key set {s.tail}</Badge>
                ) : s.needed === "required" ? (
                  <Badge tone="quiet">off — needs a key</Badge>
                ) : (
                  <Badge tone="quiet">works without a key</Badge>
                )}
                <a
                  href={s.signUp}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-xs text-[var(--color-accent)] hover:underline"
                >
                  Get a key ↗
                </a>
              </div>
              <p className="mt-1 text-sm text-[var(--color-muted)]">{s.adds}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  className={`${inputClass} max-w-sm`}
                  placeholder={s.hint ?? (s.set ? "Paste a new key to replace it" : "Paste the key")}
                  value={draft[s.id] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                />
                <Button
                  onClick={() => save(s.id, draft[s.id] ?? "")}
                  disabled={busy === s.id || !(draft[s.id] ?? "").trim()}
                >
                  Save
                </Button>
                {s.set && (
                  <Button onClick={() => save(s.id, "")} disabled={busy === s.id}>
                    Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </Card>
  );
}
