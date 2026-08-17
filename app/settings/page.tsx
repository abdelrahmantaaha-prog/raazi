"use client";

import { useEffect, useState } from "react";
import { Button, Card, Field, inputClass } from "../components/ui";
import { PROVIDERS, PROVIDER_IDS, STAGES, STAGE_LABEL, STAGE_NOTE, type ProviderId, type Stage } from "@/lib/providers";
import { CorrectionsCard } from "./Corrections";

interface KeyRow {
  id: string;
  label: string;
  provider: ProviderId;
  model: string;
  hint: string;
  status: "active" | "waiting" | "rejected" | "off";
  availableAt: string | null;
  lastError: string | null;
  calls: number;
  tokens: number;
  fromEnv: boolean;
}

interface Settings {
  keys: KeyRow[];
  keyRetryMinutes: number;
  routing: Partial<Record<Stage, ProviderId>>;
  nonLatinProvider: ProviderId;
  model: string;
  tier: "free" | "paid";
  requestsPerMinute: number;
  entryThreshold: number;
  autoRefreshEntries: boolean;
  defaultBudget: number;
  morningChores: boolean;
  morningHour: number;
}

export default function SettingsPage() {
  const [cfg, setCfg] = useState<Settings | null>(null);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<ProviderId>("gemini");
  const [keyModel, setKeyModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/settings")
      .then((r) => r.json())
      .then(setCfg);
  }, []);

  const save = async (patch: Record<string, unknown>, note?: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save.");
      setCfg(data);
      setMessage(data.note ?? note ?? null);
      setKey("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) return <p className="text-sm text-[var(--color-muted)]">Loading…</p>;

  const usable = cfg.keys.filter((k) => k.status === "active").length;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Everything stays on this machine: your sources, the database, and your keys.
          {cfg.keys.length > 0 && (
            <>
              {" "}
              {usable} of {cfg.keys.length} key{cfg.keys.length === 1 ? "" : "s"} ready to use.
            </>
          )}
        </p>
      </div>

      <Card>
        <h2 className="font-serif text-lg font-semibold">API keys</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Add as many as you like, from as many services as you like. When one runs out of daily
          quota it is set aside until it resets and the work carries straight on with the next key —
          and then, if that whole service is spent, with the next service. A run only stops when
          nothing can answer, and then only until the first key anywhere comes back.
        </p>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Keys are stored server-side in{" "}
          <code className="rounded bg-neutral-100 px-1">data/config.json</code>, not in your
          browser — ingestion keeps running with no tab open, so the background worker needs to
          reach them on its own.
        </p>

        {cfg.keys.length > 0 && (
          <ul className="mt-4 divide-y divide-[var(--color-rule)] rounded border border-[var(--color-rule)]">
            {cfg.keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <KeyStatusDot status={k.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{k.label}</span>
                    <span className="rounded bg-[var(--color-accent-soft)] px-1.5 text-xs text-[var(--color-accent)]">
                      {PROVIDERS[k.provider]?.label ?? k.provider}
                    </span>
                    <span className="font-mono text-xs text-[var(--color-muted)]">{k.hint}</span>
                    <span className="font-mono text-xs text-[var(--color-muted)]">{k.model}</span>
                    {k.fromEnv && (
                      <span className="text-xs text-[var(--color-muted)]">from your environment</span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--color-muted)]">
                    {k.status === "waiting" && k.availableAt
                      ? `Out of quota — back at ${new Date(k.availableAt).toLocaleString()}`
                      : k.status === "rejected"
                        ? k.lastError ?? "Rejected"
                        : k.status === "off"
                          ? "Set aside"
                          : k.calls > 0
                            ? `${k.calls} call${k.calls === 1 ? "" : "s"} · ${k.tokens.toLocaleString()} tokens`
                            : "Ready"}
                  </p>
                </div>
                <div className="flex gap-1">
                  {(k.status === "waiting" || k.status === "rejected") && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => save({ keyId: k.id, keyAction: "revive" }, "")}
                      title="Try this key again right now"
                    >
                      Retry
                    </Button>
                  )}
                  {!k.fromEnv && (
                    <>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          save(
                            { keyId: k.id, keyAction: k.status === "off" ? "enable" : "disable" },
                            ""
                          )
                        }
                      >
                        {k.status === "off" ? "Use" : "Pause"}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Remove “${k.label}”?`)) {
                            void save({ keyId: k.id, keyAction: "remove" }, "");
                          }
                        }}
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 rounded border border-[var(--color-rule)] p-3">
          <div className="flex flex-wrap gap-2">
            <select
              className={`${inputClass} max-w-[13rem]`}
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as ProviderId);
                setKeyModel("");
                setBaseUrl("");
              }}
            >
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {PROVIDERS[id].label}
                </option>
              ))}
            </select>
            <input
              className={`${inputClass} min-w-[10rem] flex-1`}
              type="password"
              placeholder="Paste the key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <input
              className={`${inputClass} max-w-[9rem]`}
              placeholder="Label (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            <input
              className={`${inputClass} min-w-[12rem] flex-1`}
              placeholder={`Model (default: ${PROVIDERS[provider].defaultModel})`}
              value={keyModel}
              onChange={(e) => setKeyModel(e.target.value)}
            />
            {provider === "custom" && (
              <input
                className={`${inputClass} min-w-[12rem] flex-1`}
                placeholder={`Endpoint (default: ${PROVIDERS.custom.baseUrl})`}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            )}
            <Button
              variant="primary"
              disabled={busy || !key.trim()}
              onClick={() => {
                void save(
                  {
                    addKey: key.trim(),
                    label: label.trim() || undefined,
                    provider,
                    keyModel: keyModel.trim() || undefined,
                    baseUrl: baseUrl.trim() || undefined,
                  },
                  ""
                );
                setLabel("");
                setKeyModel("");
              }}
            >
              {busy ? "Checking…" : "Add key"}
            </Button>
          </div>

          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {PROVIDERS[provider].note}{" "}
            <span className="whitespace-nowrap">Free tier: {PROVIDERS[provider].freeTier}.</span>
            {!PROVIDERS[provider].keysMultiply && provider !== "custom" && (
              <>
                {" "}
                <strong>Extra keys here buy nothing</strong> — usage is counted per account, not per
                key.
              </>
            )}
            {PROVIDERS[provider].keysUrl && (
              <>
                {" "}
                <a
                  href={PROVIDERS[provider].keysUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Get a key
                </a>
                .
              </>
            )}
          </p>
        </div>
      </Card>

      <RoutingCard cfg={cfg} busy={busy} onSave={save} />

      <Card>
        <h2 className="font-serif text-lg font-semibold">Pace</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Free keys allow only a few requests a minute. Waiting between calls is cheaper than
          getting rate-limited and unwinding the work, so the worker paces itself to this number.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Key tier">
            <select
              className={inputClass}
              value={cfg.tier}
              onChange={(e) => save({ tier: e.target.value }, "Pace updated.")}
            >
              <option value="free">Free</option>
              <option value="paid">Paid</option>
            </select>
          </Field>
          <Field label="Requests per minute" hint="0 disables pacing entirely.">
            <input
              className={inputClass}
              type="number"
              min={0}
              defaultValue={cfg.requestsPerMinute}
              onBlur={(e) => save({ requestsPerMinute: Number(e.target.value) }, "Pace updated.")}
            />
          </Field>
          <Field
            label="Retry a refused key after"
            hint="Minutes. Providers report a spent minute and a spent day almost identically, so a refused key is not written off — it comes back after this long, and the wait only doubles if it is refused again."
          >
            <input
              className={inputClass}
              type="number"
              min={1}
              defaultValue={cfg.keyRetryMinutes}
              onBlur={(e) => save({ keyRetryMinutes: Number(e.target.value) }, "Retry interval updated.")}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="font-serif text-lg font-semibold">Cost</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field
            label="Write entries at"
            hint="Entities with at least this many quotes get an entry automatically. The rest wait until you open them."
          >
            <input
              className={inputClass}
              type="number"
              min={1}
              defaultValue={cfg.entryThreshold}
              onBlur={(e) => save({ entryThreshold: Number(e.target.value) }, "Threshold updated.")}
            />
          </Field>
          <Field
            label="Keep entries current"
            hint="When new evidence arrives, rewrite the entries it affects without asking. Entries you already have are always refreshed, however small the entity — the threshold above only governs writing a first one."
          >
            <select
              className={inputClass}
              value={cfg.autoRefreshEntries ? "on" : "off"}
              onChange={(e) =>
                save({ autoRefreshEntries: e.target.value === "on" }, "Updated.")
              }
            >
              <option value="on">Update them automatically</option>
              <option value="off">Only when I ask</option>
            </select>
          </Field>
          <Field label="Default token cap per source" hint="0 means no cap. A run parks itself when it hits this.">
            <input
              className={inputClass}
              type="number"
              min={0}
              step={10000}
              defaultValue={cfg.defaultBudget}
              onBlur={(e) => save({ defaultBudget: Number(e.target.value) }, "Budget updated.")}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="font-serif text-lg font-semibold">Model</h2>
        <Field label="Generation model" hint="An alias is safer than a pinned version — it survives retirements.">
          <input
            className={inputClass}
            defaultValue={cfg.model}
            onBlur={(e) => save({ model: e.target.value }, "Model updated.")}
          />
        </Field>
      </Card>

      <Card>
        <h2 className="font-serif text-lg font-semibold">Morning routine</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Once a day, without being asked: entries carrying more than one verification
          flag are rewritten — the writer is handed the flags and investigates each one
          — and the picture hunt runs for anything that earned an entry since yesterday.
          Runs at the first opportunity after the hour, so a laptop asleep at seven
          catches up when it wakes.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Run it" hint="The rewrites spend tokens; the picture hunt is free.">
            <select
              className={inputClass}
              value={cfg.morningChores ? "on" : "off"}
              onChange={(e) => save({ morningChores: e.target.value === "on" }, "Updated.")}
            >
              <option value="on">Every morning</option>
              <option value="off">Never — I will do it by hand</option>
            </select>
          </Field>
          <Field label="After" hint="Local time.">
            <select
              className={inputClass}
              value={String(cfg.morningHour)}
              onChange={(e) => save({ morningHour: Number(e.target.value) }, "Updated.")}
            >
              {[5, 6, 7, 8, 9, 10, 12].map((h) => (
                <option key={h} value={String(h)}>
                  {h}:00
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <CorrectionsCard />

      {message && <p className="text-sm text-emerald-700">{message}</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}

/**
 * Which service handles which stage. `extract` is the one that matters — it is
 * roughly 88% of all tokens — so the panel says so rather than presenting four
 * equal-looking dropdowns.
 */
function RoutingCard({
  cfg,
  busy,
  onSave,
}: {
  cfg: Settings;
  busy: boolean;
  onSave: (patch: Record<string, unknown>, note?: string) => void;
}) {
  const configured = [...new Set(cfg.keys.filter((k) => k.status !== "off").map((k) => k.provider))];
  const choices: ProviderId[] = configured.length ? configured : ["gemini"];

  return (
    <Card>
      <h2 className="font-serif text-lg font-semibold">Who does what</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Reading passages is the bulk of the work and needs nothing but text, so moving it to a
        service with a bigger free allowance is what makes a Gemini quota last. Everything else is
        small enough to leave where it is.
      </p>

      {configured.length < 2 && (
        <p className="mt-2 rounded bg-[var(--color-accent-soft)] px-3 py-2 text-sm">
          Add a key for a second service above and it will appear as an option here.
        </p>
      )}

      <div className="mt-3 space-y-3">
        {STAGES.map((stage) => (
          <div key={stage} className="flex flex-wrap items-center gap-3">
            <div className="min-w-[13rem] flex-1">
              <div className="text-sm font-medium">{STAGE_LABEL[stage]}</div>
              <div className="text-xs text-[var(--color-muted)]">{STAGE_NOTE[stage]}</div>
            </div>
            <select
              className={`${inputClass} max-w-[13rem]`}
              disabled={busy || choices.length < 2}
              value={cfg.routing?.[stage] ?? "gemini"}
              onChange={(e) => onSave({ routing: { [stage]: e.target.value as ProviderId } })}
            >
              {choices.map((id) => (
                <option key={id} value={id}>
                  {PROVIDERS[id].label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="mt-4 border-t border-[var(--color-rule)] pt-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[13rem] flex-1">
            <div className="text-sm font-medium">Arabic and other non-Latin sources</div>
            <div className="text-xs text-[var(--color-muted)]">
              Overrides the choices above for those sources. The cheaper services are appreciably
              weaker outside Latin script, and a name they miss is lost silently rather than slowly.
            </div>
          </div>
          <select
            className={`${inputClass} max-w-[13rem]`}
            disabled={busy || choices.length < 2}
            value={cfg.nonLatinProvider ?? "gemini"}
            onChange={(e) => onSave({ nonLatinProvider: e.target.value as ProviderId })}
          >
            {choices.map((id) => (
              <option key={id} value={id}>
                {PROVIDERS[id].label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="mt-4 text-xs text-[var(--color-muted)]">
        Scanned-page OCR, transcription and entity embeddings are not listed: they need to read
        images or audio, or to produce vectors, and only Gemini does those on a free tier. They stay
        there whatever you choose here.
      </p>
    </Card>
  );
}

function KeyStatusDot({ status }: { status: KeyRow["status"] }) {
  const [color, title] = {
    active: ["bg-emerald-500", "Ready"],
    waiting: ["bg-amber-500", "Out of quota — comes back on its own"],
    rejected: ["bg-red-500", "Rejected by Google"],
    off: ["bg-neutral-300", "Set aside"],
  }[status];
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} title={title} />;
}
