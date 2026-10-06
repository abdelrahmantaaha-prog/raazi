"use client";

import { useEffect, useState } from "react";
import { Button, Card, Field, inputClass } from "../components/ui";
import { PLAN_MODELS } from "@/lib/claude-models";

interface Account {
  installed: boolean;
  signedIn: boolean;
  email: string | null;
  plan: string | null;
  method: string | null;
  error?: string;
}
interface Login {
  state: "idle" | "waiting" | "done" | "failed";
  url: string | null;
  error: string | null;
}

const planName = (p: string | null) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : "");

/**
 * "Claude (your plan)": which Claude account Claude Code is signed in to on
 * this computer, signing in to another without a terminal, and which Claude
 * to ask. Signing in happens on Claude's own page; this starts it, shows the
 * link, and takes the code Claude shows when it asks for one.
 */
export function ClaudePlanCard({
  model,
  busy: saving,
  onModel,
}: {
  model: string;
  busy: boolean;
  onModel: (m: string) => void;
}) {
  const [account, setAccount] = useState<Account | null>(null);
  const [login, setLogin] = useState<Login>({ state: "idle", url: null, error: null });
  const [local, setLocal] = useState(true);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    fetch("/api/claude-account")
      .then((r) => r.json())
      .then((j) => {
        setAccount(j.account);
        setLogin(j.login);
        setLocal(j.local);
      })
      .catch(() => {});

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (login.state !== "waiting") return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [login.state]);

  const act = async (action: "start" | "code" | "cancel") => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/claude-account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, code }),
      });
      const j = await r.json();
      if (!r.ok) setError(j.error);
      else {
        setLogin(j.login);
        if (action === "code") setCode("");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const ok = account?.signedIn && account.method === "claude.ai";
  return (
    <Card>
      <h2 className="font-serif text-lg font-semibold">Claude (your plan)</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Corpus uses Claude through your plan on this computer. When the plan&apos;s limits run out, the work waits or
        moves to another service until they reset.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <span className={ok ? "font-medium" : "font-medium text-red-700"}>
          {!account
            ? "Checking…"
            : !account.installed
              ? "Claude Code is not installed on this computer."
              : !account.signedIn
                ? "Not signed in."
                : account.method !== "claude.ai"
                  ? "Signed in with an API key, not a Claude plan."
                  : `Signed in as ${account.email ?? "—"} · ${planName(account.plan)} plan`}
        </span>
        {local && account?.installed && login.state !== "waiting" && (
          <Button disabled={busy} onClick={() => void act("start")}>
            {account.signedIn ? "Switch account" : "Sign in"}
          </Button>
        )}
      </div>
      {account?.error && <p className="mt-1 text-sm text-[var(--color-muted)]">{account.error}</p>}
      {!local && (
        <p className="mt-1 text-sm text-[var(--color-muted)]">Open Corpus on this computer to change the Claude account.</p>
      )}

      {login.state === "waiting" && (
        <div className="mt-3 rounded border border-[var(--color-rule)] p-3 text-sm">
          <p className="text-[var(--color-muted)]">
            A Claude sign-in page has opened in the browser on this computer — sign in there with the account you want.
            If it did not open, or you would rather sign in on another device,{" "}
            {login.url ? (
              <a className="underline" href={login.url} target="_blank" rel="noreferrer">
                open the sign-in page
              </a>
            ) : (
              "wait a moment for the link"
            )}
            . If Claude then shows a code, paste it here.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              className={`${inputClass} min-w-[12rem] flex-1`}
              placeholder="Code from Claude's page"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button variant="primary" disabled={busy || !code.trim()} onClick={() => void act("code")}>
              Send code
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void act("cancel")}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {login.state === "done" && (
        <p className="mt-2 text-sm text-[var(--color-muted)]">Signed in. Corpus uses this account from now on.</p>
      )}
      {login.state === "failed" && login.error && (
        <p className="mt-2 text-sm text-red-700">Sign-in did not finish: {login.error}</p>
      )}
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}

      <div className="mt-3">
        <Field label="Model">
          <select className={inputClass} disabled={saving} value={model} onChange={(e) => onModel(e.target.value)}>
            {PLAN_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {m.line}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Card>
  );
}
