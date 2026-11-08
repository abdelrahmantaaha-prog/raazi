"use client";

import { useEffect, useState } from "react";
import { Button, Card, Field, inputClass } from "../components/ui";
import { OFFERED_PROVIDER_IDS, PROVIDERS, STAGES, STAGE_LABEL, STAGE_NOTE, type ProviderId, type Stage } from "@/lib/providers";
import { formatDateTime, relativeDate } from "@/lib/dates";
import { CorrectionsCard } from "./Corrections";
import { LessonsCard } from "./Lessons";
import { ResearchToolsCard } from "./ResearchTools";
import { Disciplines } from "./Disciplines";
import { LanCard, SyncCard } from "./SyncCard";
import { UpdatesCard } from "./UpdatesCard";
import { ClaudePlanCard } from "./ClaudePlan";
import { PLAN_MODELS, STAGE_PLAN_ADVICE, planModelName } from "@/lib/claude-models";

/** The languages entries can be written in. Quotes stay in their own. */
const ENTRY_LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["ar", "Arabic"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["de", "German"],
];

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
  stageModels?: Partial<Record<Stage, string>>;
  model: string;
  tier: "free" | "paid";
  requestsPerMinute: number;
  entryThreshold: number;
  autoRefreshEntries: boolean;
  defaultBudget: number;
  morningChores: boolean;
  feedPolling: boolean;
  feedReview: boolean;
  dailyBrief: boolean;
  briefHours: number;
  morningHour: number;
  entryLanguage?: string;
  claudeModel?: string;
}


type Tab = "general" | "ai" | "research" | "libraries" | "learned" | "access";
const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "ai", label: "AI" },
  { id: "research", label: "Research tools" },
  { id: "libraries", label: "Libraries" },
  { id: "learned", label: "What it has learned" },
  { id: "access", label: "Phone & other laptop" },
];

type Save = (patch: Record<string, unknown>, note?: string) => Promise<boolean>;

/**
 * Settings, in tabs.
 *
 * It had grown to fourteen cards in one column — keys, routing, pacing, the
 * feeds, the brief, sync, lessons — each with a paragraph of its own, so
 * finding the entry language meant reading past the request rate (6 Oct
 * 2026). Now the things you change day to day are on General, the AI services
 * on their own tab with the technical knobs folded away, and everything else
 * one tab each. The tab is in the address (#ai), so a link can open it.
 */
export default function SettingsPage() {
  const [cfg, setCfg] = useState<Settings | null>(null);
  const [tab, setTab] = useState<Tab>("general");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/settings")
      .then((r) => r.json())
      .then(setCfg);
    const fromHash = () => {
      const wanted = window.location.hash.slice(1) as Tab;
      if (TABS.some((t) => t.id === wanted)) setTab(wanted);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  const pick = (t: Tab) => {
    setTab(t);
    setMessage(null);
    setError(null);
    history.replaceState(null, "", `#${t}`);
  };

  const save: Save = async (patch, note) => {
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
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) return <p className="text-sm text-[var(--color-muted)]">Loading…</p>;

  const usable = cfg.keys.filter((k) => k.status === "active").length;
  const onPlan = cfg.keys.some((k) => k.provider === "claude-code");

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Everything stays on this computer.
          {cfg.keys.length > 0 && ` ${usable} of ${cfg.keys.length} AI service${cfg.keys.length === 1 ? "" : "s"} ready.`}
        </p>
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-[var(--color-rule)]" aria-label="Settings sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => pick(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={`-mb-px rounded-t border px-3 py-1.5 text-sm ${
              tab === t.id
                ? "border-[var(--color-rule)] border-b-white bg-white font-medium"
                : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {(message || error) && (
        <p className={`text-sm ${error ? "text-red-700" : "text-emerald-700"}`} role="status">
          {error ?? message}
        </p>
      )}

      {tab === "general" && <General cfg={cfg} busy={busy} save={save} />}

      {tab === "ai" && (
        <>
          {onPlan && (
            <ClaudePlanCard
              model={cfg.claudeModel ?? "claude-sonnet-5-5"}
              busy={busy}
              onModel={(m) => void save({ claudeModel: m }, "Model updated.")}
            />
          )}
          {cfg.keys.some((k) => k.provider === "anthropic") && (
            <p className="rounded border border-[var(--color-rule)] bg-[var(--color-accent-soft)] px-3 py-2 text-sm">
              <span className="font-medium">Claude is metered, not free.</span>{" "}
              <span className="text-[var(--color-muted)]">
                Every other service here refuses you when its allowance runs out; this one bills you
                instead. So the routing below is a spending decision — reading a book is millions of
                tokens, writing its entries is thousands. The per-model rates are on the key form
                above.
              </span>
            </p>
          )}
          <RoutingCard cfg={cfg} busy={busy} onSave={save} />
          <KeysCard cfg={cfg} busy={busy} save={save} />
          <Advanced cfg={cfg} save={save} />
        </>
      )}

      {tab === "research" && <ResearchToolsCard />}
      {tab === "libraries" && <Disciplines />}
      {tab === "learned" && (
        <>
          <LessonsCard />
          <CorrectionsCard />
        </>
      )}
      {tab === "access" && (
        <>
          <LanCard />
          <SyncCard />
          <UpdatesCard />
        </>
      )}
    </div>
  );
}

/** What you change day to day: the language, the entries, the news, the morning. */
function General({ cfg, busy, save }: { cfg: Settings; busy: boolean; save: Save }) {
  const onOff = (v: boolean) => (v ? "on" : "off");
  return (
    <>
      <Card>
        <h2 className="font-serif text-lg font-semibold">Entries</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Write entries in" hint="Quotes always stay in their own language.">
            <select
              className={inputClass}
              value={cfg.entryLanguage ?? "en"}
              disabled={busy}
              onChange={(e) => void save({ entryLanguage: e.target.value }, "Entry language updated.")}
            >
              {ENTRY_LANGUAGES.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Write an entry once a name has" hint="This many quotes. Smaller names wait until you open them.">
            <input
              className={inputClass}
              type="number"
              min={1}
              defaultValue={cfg.entryThreshold}
              onBlur={(e) => void save({ entryThreshold: Number(e.target.value) }, "Updated.")}
            />
          </Field>
          <Field label="When new evidence arrives">
            <select
              className={inputClass}
              value={onOff(cfg.autoRefreshEntries)}
              onChange={(e) => void save({ autoRefreshEntries: e.target.value === "on" }, "Updated.")}
            >
              <option value="on">Update the entries it touches</option>
              <option value="off">Only when I ask</option>
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="font-serif text-lg font-semibold">News</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Fetching articles is free; reading one is what costs, so by default they wait in the inbox for you.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Check the feeds">
            <select
              className={inputClass}
              value={onOff(cfg.feedPolling)}
              onChange={(e) => void save({ feedPolling: e.target.value === "on" }, "Updated.")}
            >
              <option value="on">Automatically</option>
              <option value="off">Only when I ask</option>
            </select>
          </Field>
          <Field label="New articles">
            <select
              className={inputClass}
              value={onOff(cfg.feedReview)}
              onChange={(e) => void save({ feedReview: e.target.value === "on" }, "Updated.")}
            >
              <option value="on">Wait in the inbox for me</option>
              <option value="off">Read them all on arrival</option>
            </select>
          </Field>
          <Field label="Daily brief">
            <select
              className={inputClass}
              value={onOff(cfg.dailyBrief)}
              onChange={(e) => void save({ dailyBrief: e.target.value === "on" }, "Updated.")}
            >
              <option value="on">Write one each day</option>
              <option value="off">Only when I ask</option>
            </select>
          </Field>
          <Field label="The brief covers the last">
            <select
              className={inputClass}
              value={String(cfg.briefHours ?? 24)}
              onChange={(e) => void save({ briefHours: Number(e.target.value) }, "Updated.")}
            >
              {[12, 24, 36, 48, 72].map((h) => (
                <option key={h} value={String(h)}>
                  {h} hours
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="font-serif text-lg font-semibold">Morning routine</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Rewrites entries with more than one verification flag, and finds pictures for new entries.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Run it">
            <select
              className={inputClass}
              value={onOff(cfg.morningChores)}
              onChange={(e) => void save({ morningChores: e.target.value === "on" }, "Updated.")}
            >
              <option value="on">Every morning</option>
              <option value="off">Never</option>
            </select>
          </Field>
          <Field label="After" hint="Or as soon as the computer wakes after that.">
            <select
              className={inputClass}
              value={String(cfg.morningHour)}
              onChange={(e) => void save({ morningHour: Number(e.target.value) }, "Updated.")}
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
    </>
  );
}

/** Keys for the AI services: the list, and the form to add one. */
function KeysCard({ cfg, busy, save }: { cfg: Settings; busy: boolean; save: Save }) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<ProviderId>("gemini");
  const [keyModel, setKeyModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  return (
    <Card>
      <h2 className="font-serif text-lg font-semibold">Other AI services</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Gemini, local models and others, for whatever you route to them. When one runs out, the
        work moves to the next. Keys stay on this computer.
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
                    ? `Out of quota — back ${relativeDate(k.availableAt)} (${formatDateTime(k.availableAt)})`
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
            {OFFERED_PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {PROVIDERS[id].label}
              </option>
            ))}
          </select>
          {/* The plan has no key: Claude Code on this computer is already signed in. */}
          {provider !== "claude-code" && (
            <input
              className={`${inputClass} min-w-[10rem] flex-1`}
              type="password"
              placeholder="Paste the key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          )}
          <input
            className={`${inputClass} max-w-[9rem]`}
            placeholder="Label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          {/* The plan's model is picked in its own card, once it is added. */}
          {provider !== "claude-code" && (
            <input
              className={`${inputClass} min-w-[12rem] flex-1`}
              placeholder={`Model (default: ${PROVIDERS[provider].defaultModel})`}
              value={keyModel}
              onChange={(e) => setKeyModel(e.target.value)}
            />
          )}
          {provider === "ollama" && (
            <input
              className={`${inputClass} min-w-[12rem] flex-1`}
              placeholder={`Endpoint (default: ${PROVIDERS.ollama.baseUrl})`}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          )}
          <Button
            variant="primary"
            disabled={busy || (provider !== "claude-code" && !key.trim())}
            onClick={() => {
              void save(
                {
                  // The ring wants a value; the plan has none, so it gets a fixed one.
                  addKey: provider === "claude-code" ? "claude-plan" : key.trim(),
                  label: label.trim() || undefined,
                  provider,
                  keyModel: keyModel.trim() || undefined,
                  baseUrl: baseUrl.trim() || undefined,
                },
                ""
              ).then((ok) => {
                // A key that was refused stays in the box, to be corrected.
                if (ok) setKey("");
              });
              setLabel("");
              setKeyModel("");
            }}
          >
            {busy ? "Checking…" : provider === "claude-code" ? "Add Claude (your plan)" : "Add key"}
          </Button>
        </div>

        <p className="mt-2 text-sm text-[var(--color-muted)]">
          {PROVIDERS[provider].note}{" "}
          <span className="whitespace-nowrap">Free tier: {PROVIDERS[provider].freeTier}.</span>
          {!PROVIDERS[provider].keysMultiply && provider !== "ollama" && (
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
  );
}

/** The knobs almost nobody needs, folded away: the Gemini model, pacing, retries, the per-source cap. */
function Advanced({ cfg, save }: { cfg: Settings; save: Save }) {
  return (
    <details className="rounded-lg border border-[var(--color-rule)] bg-white">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Advanced</summary>
      <div className="grid gap-4 border-t border-[var(--color-rule)] p-4 sm:grid-cols-2">
        <Field label="Gemini model" hint="An alias outlives a pinned version.">
          <input className={inputClass} defaultValue={cfg.model} onBlur={(e) => void save({ model: e.target.value }, "Model updated.")} />
        </Field>
        <Field label="Gemini key tier">
          <select className={inputClass} value={cfg.tier} onChange={(e) => void save({ tier: e.target.value }, "Updated.")}>
            <option value="free">Free</option>
            <option value="paid">Paid</option>
          </select>
        </Field>
        <Field label="Requests per minute" hint="0 turns pacing off.">
          <input
            className={inputClass}
            type="number"
            min={0}
            defaultValue={cfg.requestsPerMinute}
            onBlur={(e) => void save({ requestsPerMinute: Number(e.target.value) }, "Updated.")}
          />
        </Field>
        <Field label="Try a refused key again after" hint="Minutes; doubles if it is refused again.">
          <input
            className={inputClass}
            type="number"
            min={1}
            defaultValue={cfg.keyRetryMinutes}
            onBlur={(e) => void save({ keyRetryMinutes: Number(e.target.value) }, "Updated.")}
          />
        </Field>
        <Field label="Token cap per source" hint="0 for none. A run pauses when it reaches it.">
          <input
            className={inputClass}
            type="number"
            min={0}
            step={10000}
            defaultValue={cfg.defaultBudget}
            onBlur={(e) => void save({ defaultBudget: Number(e.target.value) }, "Updated.")}
          />
        </Field>
      </div>
    </details>
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
        Which service, and which Claude, does each job. Reading passages is most of the work.
      </p>

      {configured.length < 2 && (
        <p className="mt-2 rounded bg-[var(--color-accent-soft)] px-3 py-2 text-sm">
          Add a second service under Other AI services and it becomes a choice here.
        </p>
      )}

      {/* Only once there is a Claude key to route to, and only ever a
          suggestion: the stored routing is the reader's, and changing it from
          under them would be a surprise the next run pays for. */}
      {/* Only for a metered Claude key, where the split is a spending decision. */}
      {choices.includes("anthropic") && choices.includes("gemini") && (
        <p className="mt-2 rounded bg-[var(--color-accent-soft)] px-3 py-2 text-sm">
          <span className="font-medium">Suggested split:</span>{" "}
          <span className="text-[var(--color-muted)]">
            reading and filing on Gemini, where there are thousands of calls; writing and questions on
            Claude, where the judgement is worth the bill.
          </span>
        </p>
      )}

      <div className="mt-3 space-y-3">
        {STAGES.map((stage) => (
          <div key={stage} className="flex flex-wrap items-center gap-3">
            <div className="min-w-[13rem] flex-1">
              <div className="text-sm font-medium">{STAGE_LABEL[stage]}</div>
              <div className="text-xs text-[var(--color-muted)]">{STAGE_NOTE[stage]}</div>
              {cfg.routing?.[stage] === "claude-code" && STAGE_PLAN_ADVICE[stage] ? (
                <div className="text-xs text-[var(--color-muted)]">
                  Suggested: {planModelName(STAGE_PLAN_ADVICE[stage].model)} — {STAGE_PLAN_ADVICE[stage].why}.
                </div>
              ) : null}
            </div>
            {cfg.routing?.[stage] === "claude-code" ? (
              <select
                className={`${inputClass} max-w-[11rem]`}
                aria-label="Which Claude for this stage"
                disabled={busy}
                value={cfg.stageModels?.[stage] ?? ""}
                onChange={(e) => onSave({ stageModels: { [stage]: e.target.value } })}
              >
                <option value="">As on the Claude card ({planModelName(cfg.claudeModel ?? "claude-sonnet-5-5")})</option>
                {PLAN_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            ) : null}
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

      <p className="mt-4 text-xs text-[var(--color-muted)]">
        Scanned pages and photos follow “Reading passages”. Recordings and search by meaning need
        Gemini whatever is set here.
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

