"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Field, inputClass } from "../components/ui";
import { IconSync } from "../components/Icons";
import { formatDateTime, relativeDate } from "@/lib/dates";
import type { LocalStatus, PullEverythingResult, SyncSettings } from "@/lib/sync";

/**
 * Two cards that belong together: the door, and the other laptop.
 *
 * LAN mode is what makes this machine reachable — by a phone, by the browser
 * extension on another computer, and by the other laptop for sync. The
 * setting existed and had no page; it is drawn here because sync is the
 * thing that most often needs it switched on.
 */
export function LanCard() {
  const [lan, setLan] = useState<{
    enabled: boolean;
    token: string;
    port: number;
    addresses: string[];
    loginUrls: string[];
    note: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/lan");
    if (res.ok) setLan(await res.json());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lan: { enabled } }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Could not save.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="font-serif text-lg font-semibold">Sharing</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Off, only this computer can open Raazi. On, your phone, the browser extension and the
        other laptop can reach it over Wi-Fi or Tailscale, with a sign-in link.
      </p>
      {lan ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <select
              className={`${inputClass} max-w-[16rem]`}
              value={lan.enabled ? "on" : "off"}
              disabled={busy}
              onChange={(e) => void toggle(e.target.value === "on")}
            >
              <option value="off">This computer only</option>
              <option value="on">Shared — reachable with a sign-in link</option>
            </select>
            <span className="text-xs text-[var(--color-muted)]">{lan.note}</span>
          </div>
          <div className="text-sm">
            <span className="text-[var(--color-muted)]">Addresses: </span>
            {lan.addresses.length
              ? lan.addresses.map((a) => (
                  <code key={a} className="mr-2 rounded bg-neutral-100 px-1">
                    http://{a}:{lan.port}
                  </code>
                ))
              : "none found"}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-[var(--color-muted)]">Token:</span>
            <code className="rounded bg-neutral-100 px-1 font-mono text-xs">
              {reveal ? lan.token : `${lan.token.slice(0, 6)}…${lan.token.slice(-4)}`}
            </code>
            <Button variant="ghost" onClick={() => setReveal((v) => !v)}>
              {reveal ? "Hide" : "Show"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void navigator.clipboard?.writeText(lan.token)}
              title="Copy the token"
            >
              Copy
            </Button>
          </div>
          {lan.enabled && lan.loginUrls.length ? <PhonePairing urls={lan.loginUrls} /> : null}
        </div>
      ) : (
        <p className="mt-3 text-sm text-[var(--color-muted)]">Loading…</p>
      )}
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
    </Card>
  );
}

/**
 * A code the phone app scans to connect, once.
 *
 * It carries the sign-in link — address and token — so it is drawn only on
 * request, like the token above it. The home network's address is offered
 * first; a Tailscale one (100.64–100.127) is for when the phone is away from
 * home. Any phone camera can read it too, and opening the link signs that
 * phone's browser in.
 */
function PhonePairing({ urls }: { urls: string[] }) {
  const ordered = [...urls].sort((a, b) => Number(isTailscale(a)) - Number(isTailscale(b)));
  const [shown, setShown] = useState(false);
  const [pick, setPick] = useState(0);
  const url = ordered[Math.min(pick, ordered.length - 1)];
  return (
    <div className="rounded-lg border border-[var(--color-rule)] p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Your phone</span>
        <span className="text-[var(--color-muted)]">
          In the Raazi phone app, tap <em>Scan the code</em> and point it here.
        </span>
        <Button variant="ghost" onClick={() => setShown((v) => !v)}>
          {shown ? "Hide the code" : "Show the code"}
        </Button>
      </div>
      {shown ? (
        <div className="mt-3 flex flex-wrap items-start gap-4">
          <QrCode text={url} />
          {ordered.length > 1 ? (
            <div className="space-y-1">
              {ordered.map((u, i) => (
                <label key={u} className="flex items-center gap-2">
                  <input type="radio" checked={u === url} onChange={() => setPick(i)} />
                  <span>{isTailscale(u) ? "Away from home (Tailscale)" : "On the home Wi-Fi"}</span>
                  <code className="text-xs text-[var(--color-muted)]">{new URL(u).host}</code>
                </label>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function isTailscale(url: string): boolean {
  const m = /^https?:\/\/100\.(\d+)\./.exec(url);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/** Drawn as one SVG path, dark on white whatever the theme, which is what scanners read best. */
function QrCode({ text }: { text: string }) {
  const [path, setPath] = useState<{ d: string; n: number } | null>(null);
  useEffect(() => {
    let gone = false;
    void import("qrcode-generator").then(({ default: qrcode }) => {
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      let d = "";
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      if (!gone) setPath({ d, n });
    });
    return () => {
      gone = true;
    };
  }, [text]);
  if (!path) return <div className="h-[200px] w-[200px] rounded bg-neutral-100" />;
  const q = 4;
  return (
    <svg
      width={200}
      height={200}
      viewBox={`${-q} ${-q} ${path.n + 2 * q} ${path.n + 2 * q}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Code for the phone app"
      className="rounded"
    >
      <rect x={-q} y={-q} width={path.n + 2 * q} height={path.n + 2 * q} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

interface SyncView {
  local: LocalStatus;
  settings: SyncSettings;
  peer: LocalStatus | null;
  peerError: string | null;
}

function describe(f: LocalStatus["fingerprint"]): string {
  return `${f.sources.toLocaleString()} sources · ${f.entries.toLocaleString()} entries · ${f.decided.toLocaleString()} inbox decisions`;
}

export function SyncCard() {
  const [view, setView] = useState<SyncView | null>(null);
  const [peerUrl, setPeerUrl] = useState("");
  const [peerToken, setPeerToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/sync");
    if (!res.ok) return;
    const data = (await res.json()) as SyncView;
    setView(data);
    setPeerUrl(data.settings.peerUrl);
    setPeerToken(data.settings.peerToken);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function savePeer() {
    setBusy("saving");
    setError(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ peerUrl, peerToken }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Could not save.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function run(direction: "pull" | "push") {
    if (!view?.peer) return;
    const mine = view.local;
    const theirs = view.peer;
    const lines =
      direction === "pull"
        ? [
            `Make THIS laptop (${mine.host}) a copy of ${theirs.host}?`,
            "",
            "Every discipline it has replaces the same one here, and its settings and API keys come too.",
            "Each library here is backed up first.",
            mine.changedSinceSync ? "\nThe open library HAS CHANGED since the last sync; those changes will be replaced." : "",
          ]
        : [
            `Make ${theirs.host} a copy of THIS laptop (${mine.host})?`,
            "",
            "Every discipline here replaces the same one there, and these settings and API keys go too.",
            "Theirs are backed up first, on their machine.",
            theirs.changedSinceSync ? `\n${theirs.host} HAS CHANGED since the last sync; those changes will be replaced.` : "",
          ];
    if (!confirm(lines.filter((l) => l !== "").join("\n"))) return;
    let force = direction === "pull" ? mine.changedSinceSync : theirs.changedSinceSync;

    setBusy(direction);
    setError(null);
    setResult(null);
    try {
      const send = () =>
        fetch(`/api/sync/${direction}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: peerUrl, token: peerToken, force }),
        });
      let res = await send();
      let data = (await res.json().catch(() => ({}))) as PullEverythingResult & { error?: string };
      // Another discipline, not the open one, may have changed since its last
      // sync; only the server can see that, so it is asked about here.
      if (res.status === 409 && !force && /changed since the last sync/.test(data.error ?? "")) {
        if (!confirm(`${data.error}\n\nReplace them anyway? They are backed up first.`)) return;
        force = true;
        res = await send();
        data = (await res.json().catch(() => ({}))) as PullEverythingResult & { error?: string };
      }
      if (!res.ok) throw new Error(data.error ?? `That did not work (${res.status}).`);
      const copied = (data.disciplines ?? []).filter((d) => d.outcome === "copied").map((d) => d.name);
      const same = (data.disciplines ?? []).filter((d) => d.outcome === "same").map((d) => d.name);
      const what = [
        copied.length ? `Copied ${copied.join(", ")}.` : "",
        same.length ? `${same.join(", ")} ${same.length === 1 ? "was" : "were"} already the same.` : "",
        data.settings ? "Settings and API keys copied." : "",
      ]
        .filter(Boolean)
        .join(" ");
      setResult(
        direction === "pull"
          ? `Done in ${Math.round(data.tookMs / 1000)}s. This laptop is now a copy of ${data.from}. ${what} ${data.filesCopied} file${data.filesCopied === 1 ? "" : "s"} copied (${Math.round(data.bytesCopied / 1024 / 1024)} MB).`
          : `Done in ${Math.round(data.tookMs / 1000)}s. ${view.peer.host} is now a copy of this laptop. ${what} ${data.filesCopied} file${data.filesCopied === 1 ? "" : "s"} copied there.`
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const local = view?.local;
  const peer = view?.peer;
  const ready = Boolean(peer && !busy);

  return (
    <Card>
      <h2 className="flex items-center gap-2 font-serif text-lg font-semibold">
        <IconSync className="text-[var(--color-accent)]" /> The other laptop
      </h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        One library on two laptops. Pull makes this one a copy of the other — every discipline, the
        settings and the API keys; push does the reverse. Before you switch laptops, sync towards the
        one you are about to use. Both need sharing on.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded border border-[var(--color-rule)] p-3 text-sm">
          <p className="font-medium">This laptop{local ? ` — ${local.host}` : ""}</p>
          {local ? (
            <>
              <p className="mt-1 text-[var(--color-muted)]">{describe(local.fingerprint)}</p>
              <p className="text-xs text-[var(--color-muted)]">
                Last change {local.fingerprint.latest ? relativeDate(local.fingerprint.latest) : "unknown"} ·{" "}
                {Math.round(local.libraryBytes / 1024 / 1024)} MB · sharing {local.lan ? "on" : "off"}
              </p>
              {local.last ? (
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  Last synced {relativeDate(local.last.at)} ({local.last.direction} with {local.last.peer}).
                  {local.changedSinceSync ? " Changed here since." : " Unchanged since."}
                </p>
              ) : (
                <p className="mt-1 text-xs text-[var(--color-muted)]">Never synced.</p>
              )}
            </>
          ) : (
            <p className="text-[var(--color-muted)]">Loading…</p>
          )}
        </div>
        <div className="rounded border border-[var(--color-rule)] p-3 text-sm">
          <p className="font-medium">The other laptop{peer ? ` — ${peer.host}` : ""}</p>
          {peer ? (
            <>
              <p className="mt-1 text-[var(--color-muted)]">{describe(peer.fingerprint)}</p>
              <p className="text-xs text-[var(--color-muted)]">
                Last change {peer.fingerprint.latest ? relativeDate(peer.fingerprint.latest) : "unknown"} ·{" "}
                {Math.round(peer.libraryBytes / 1024 / 1024)} MB
                {peer.syncing ? ` · ${peer.syncing}` : ""}
              </p>
              {local && peer.fingerprint.key === local.fingerprint.key ? (
                <p className="mt-1 text-xs text-emerald-700">The two libraries are the same.</p>
              ) : null}
            </>
          ) : view?.peerError ? (
            <p className="mt-1 text-red-700">{view.peerError}</p>
          ) : (
            <p className="mt-1 text-[var(--color-muted)]">
              {view?.settings.peerUrl ? "Not answering." : "Enter its address and token below."}
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Its address" hint="Shown under Sharing on the other laptop — a Wi-Fi or Tailscale address.">
          <input
            className={inputClass}
            value={peerUrl}
            onChange={(e) => setPeerUrl(e.target.value)}
            placeholder="http://100.101.102.103:5400"
            spellCheck={false}
          />
        </Field>
        <Field label="Its token" hint="From Sharing on the other laptop.">
          <input
            className={inputClass}
            value={peerToken}
            onChange={(e) => setPeerToken(e.target.value)}
            placeholder="64 hex characters"
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <Button onClick={() => void savePeer()} disabled={busy !== null}>
          {busy === "saving" ? "Saving…" : "Save and check"}
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!ready} onClick={() => void run("pull")} title="This library becomes a copy of the other one">
          {busy === "pull" ? "Pulling…" : "Pull from it — replace this library"}
        </Button>
        <Button disabled={!ready || !local?.lan} onClick={() => void run("push")} title="The other library becomes a copy of this one">
          {busy === "push" ? "Pushing…" : "Push to it — replace theirs"}
        </Button>
        {local && !local.lan ? (
          <span className="text-xs text-[var(--color-muted)]">Pushing needs sharing on here.</span>
        ) : null}
        <Button variant="ghost" disabled={busy !== null} onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {busy === "pull" || busy === "push" ? (
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          Copying the library. The worker is paused while the file is swapped; this takes a minute
          or two on a LAN.
        </p>
      ) : null}
      {result ? <p className="mt-3 text-sm text-emerald-700">{result}</p> : null}
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      {local?.last?.at ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">Last sync {formatDateTime(local.last.at)}.</p>
      ) : null}
    </Card>
  );
}
