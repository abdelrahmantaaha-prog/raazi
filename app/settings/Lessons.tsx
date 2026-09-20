"use client";

import { useEffect, useState } from "react";
import { Button, Card, inputClass } from "../components/ui";
import { STAGE_LABEL, type Stage } from "@/lib/providers";
import { dirOf } from "@/lib/dir";

interface Lesson {
  id: number;
  stage: string;
  text: string;
  why: string | null;
  source: "user" | "seed" | "app";
  key: string | null;
  active: number;
  created_at: string;
}

interface Payload {
  lessons: Lesson[];
  stages: string[];
  cap: number;
  heldBack: Record<string, number>;
}

const stageLabel = (s: string) => (s === "all" ? "Every stage" : (STAGE_LABEL[s as Stage] ?? s));

/**
 * What the models have learned, and a place to teach them.
 *
 * A standing correction (the card above) says "this passage was wrong". A
 * lesson says "this is how the writing goes wrong": background written as
 * news, "on Monday" in a reference entry, a fact written twice from two
 * wire copies. It is given to every call of the stage it names, in your
 * words, without a rebuild — so a fault you notice in this morning's brief
 * is one tomorrow's writer already knows about.
 */
export function LessonsCard() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("entry");
  const [text, setText] = useState("");
  const [why, setWhy] = useState("");
  const [showOff, setShowOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    fetch("/api/lessons")
      .then((r) => r.json())
      .then((d: Payload) => setData(d))
      .catch(() => setData({ lessons: [], stages: ["all"], cap: 0, heldBack: {} }));

  useEffect(() => {
    void load();
  }, []);

  const call = async (init: RequestInit, url = "/api/lessons") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
      const d = (await res.json()) as Payload & { error?: string };
      if (!res.ok) {
        setError(d.error ?? "That did not work.");
        return;
      }
      setData({ lessons: d.lessons, stages: d.stages, cap: d.cap, heldBack: d.heldBack });
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!text.trim()) return;
    await call({ method: "POST", body: JSON.stringify({ stage, text, why: why.trim() || undefined }) });
    setText("");
    setWhy("");
  };

  const lessons = data?.lessons ?? [];
  const shown = lessons.filter((l) => showOff || l.active);
  const off = lessons.filter((l) => !l.active).length;
  const byStage = new Map<string, Lesson[]>();
  for (const l of shown) byStage.set(l.stage, [...(byStage.get(l.stage) ?? []), l]);
  const order = ["all", "entry", "brief", "extract", "verify", "tag", "resolve"];
  const groups = [...byStage.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));

  return (
    <Card>
      <h2 className="font-serif text-lg font-semibold">
        What the models have learned{data ? ` (${lessons.filter((l) => l.active).length})` : ""}
      </h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Standing instructions, in your words, given to every call of the stage they name — the entry
        writer, the brief, extraction, the verifier, filing. Corpus ships with the ones its own audits
        taught it; add yours when a brief or an entry goes wrong in a way you can name, and it applies
        from the next call, no rebuild. Each stage is given at most {data?.cap ?? 16}, yours first.
      </p>

      <div className="mt-4 space-y-2 rounded-lg border border-[var(--color-rule)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm">
            Teach the{" "}
            <select className={inputClass} value={stage} onChange={(e) => setStage(e.target.value)}>
              {(data?.stages ?? ["all", "entry", "brief", "extract", "verify", "tag", "resolve"]).map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? "models, at every stage" : stageLabel(s)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <textarea
          className={`${inputClass} min-h-[4.5rem] w-full`}
          placeholder='The lesson, as an instruction: "Write the date, never the weekday."'
          value={text}
          onChange={(e) => setText(e.target.value)}
          dir={dirOf(text)}
        />
        <input
          className={`${inputClass} w-full`}
          placeholder="What went wrong that taught it (optional, for you rather than the model)"
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          dir={dirOf(why)}
        />
        <div className="flex items-center gap-3">
          <Button onClick={add} disabled={busy || !text.trim()}>
            Add the lesson
          </Button>
          {error && <span className="text-sm text-[var(--color-danger,#b91c1c)]">{error}</span>}
        </div>
      </div>

      {groups.length > 0 && (
        <div className="mt-4 space-y-4">
          {groups.map(([s, list]) => (
            <div key={s}>
              <h3 className="text-sm font-medium">
                {stageLabel(s)}
                {data?.heldBack?.[s] ? (
                  <span className="ml-2 text-xs font-normal text-[var(--color-muted)]">
                    {data.heldBack[s]} past the cap and not sent — switch some off
                  </span>
                ) : null}
              </h3>
              <ul className="mt-2 space-y-2">
                {list.map((l) => (
                  <li
                    key={l.id}
                    className={`border-l-2 pl-3 ${l.active ? "border-[var(--color-rule)]" : "border-transparent opacity-60"}`}
                  >
                    <p className="text-sm" dir={dirOf(l.text)}>
                      {l.text}
                    </p>
                    {l.why && (
                      <p className="mt-0.5 text-xs italic text-[var(--color-muted)]" dir={dirOf(l.why)}>
                        {l.why}
                      </p>
                    )}
                    <div className="mt-1 flex items-center gap-2 text-xs text-[var(--color-muted)]">
                      <span>{l.source === "seed" ? "shipped with Corpus" : l.source === "app" ? "added by Corpus" : "yours"}</span>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => call({ method: "PATCH", body: JSON.stringify({ id: l.id, active: !l.active }) })}
                      >
                        {l.active ? "Switch off" : "Switch on"}
                      </Button>
                      {l.source !== "seed" && (
                        <Button variant="ghost" disabled={busy} onClick={() => call({ method: "DELETE" }, `/api/lessons?id=${l.id}`)}>
                          Remove
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {off > 0 && (
        <button className="mt-3 text-xs text-[var(--color-accent)] hover:underline" onClick={() => setShowOff((v) => !v)}>
          {showOff ? "Hide" : "Show"} the {off} switched off
        </button>
      )}
    </Card>
  );
}
