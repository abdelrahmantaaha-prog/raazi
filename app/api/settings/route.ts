import { NextResponse } from "next/server";
import { badRequest, readBody } from "@/lib/http";
import { getConfig, publicConfig, saveConfig } from "@/lib/config";
import type { ProviderId, Stage } from "@/lib/providers";
import { validateKey } from "@/lib/ai/client";
import { addKey, removeKey, reviveKey, setKey } from "@/lib/keys";
import { wakeParkedRuns } from "@/lib/queue";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(publicConfig());
}

export async function POST(req: Request) {
  const body = await readBody<{
    /** Key management. */
    addKey?: string;
    label?: string;
    provider?: ProviderId;
    keyModel?: string;
    baseUrl?: string;
    keyId?: string;
    keyAction?: "remove" | "revive" | "rename" | "disable" | "enable";
    /** Routing. */
    routing?: Partial<Record<Stage, ProviderId>>;
    nonLatinProvider?: ProviderId;
    /** Everything else. */
    model?: string;
    tier?: "free" | "paid";
    requestsPerMinute?: number;
    keyRetryMinutes?: number;
    entryThreshold?: number;
    autoRefreshEntries?: boolean;
    defaultBudget?: number;
    morningChores?: boolean;
    morningHour?: number;
  }>(req);
  if (body === null) return badRequest("Malformed JSON body.");

  let note: string | undefined;

  if (body.addKey?.trim()) {
    const provider = body.provider ?? "gemini";
    const check = await validateKey(
      body.addKey.trim(),
      provider,
      body.keyModel?.trim() || undefined,
      body.baseUrl?.trim() || undefined
    );
    if (!check.ok) {
      return NextResponse.json({ error: check.error ?? "Key rejected." }, { status: 400 });
    }
    const added = addKey(body.addKey.trim(), body.label, {
      provider,
      model: body.keyModel,
      baseUrl: body.baseUrl,
    });
    // A key added while everything else is spent should get work moving again.
    // The parked runs are waiting on a guess about when a key would return;
    // one just did, so the guess is void.
    wakeParkedRuns();
    kickWorker();
    note = check.error
      ? `Added “${added.label}” — ${check.error}`
      : `Added “${added.label}”.`;
  }

  if (body.keyId && body.keyAction) {
    switch (body.keyAction) {
      case "remove":
        removeKey(body.keyId);
        note = "Key removed.";
        break;
      case "revive":
        reviveKey(body.keyId);
        wakeParkedRuns();
        kickWorker();
        note = "Key put back in the rotation.";
        break;
      case "rename":
        setKey(body.keyId, { label: body.label ?? "" });
        break;
      case "disable":
        setKey(body.keyId, { disabled: true });
        note = "Key set aside.";
        break;
      case "enable":
        setKey(body.keyId, { disabled: false });
        wakeParkedRuns();
        kickWorker();
        note = "Key back in the rotation.";
        break;
    }
  }

  const patch: Record<string, unknown> = {};
  for (const k of [
    "model",
    "tier",
    "requestsPerMinute",
    "keyRetryMinutes",
    "entryThreshold",
    "autoRefreshEntries",
    "defaultBudget",
    "morningChores",
    "morningHour",
  ] as const) {
    if (body[k] !== undefined) patch[k] = body[k];
  }

  if (body.routing) {
    // Merge rather than replace, so setting one stage does not clear the rest.
    patch.routing = { ...getConfig().routing, ...body.routing };
    note = "Routing updated.";
  }
  if (body.nonLatinProvider) patch.nonLatinProvider = body.nonLatinProvider;
  // The free tier's per-minute ceiling is low; keep the pacer honest about it.
  if (body.tier === "free" && body.requestsPerMinute === undefined) patch.requestsPerMinute = 10;
  if (body.tier === "paid" && body.requestsPerMinute === undefined) patch.requestsPerMinute = 120;

  if (Object.keys(patch).length) saveConfig(patch);

  return NextResponse.json({ ...publicConfig(), note });
}
