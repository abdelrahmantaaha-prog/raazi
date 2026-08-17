"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Empty, inputClass } from "../components/ui";
import { dirOf } from "@/lib/dir";

interface Question {
  id: number;
  question: string;
  answer_md: string | null;
  evidence: string;
  state: string;
  tag_name: string | null;
  created_at: string;
}

interface TagRow {
  id: number;
  name: string;
}

const SUGGESTIONS = [
  "Tell me everything you know about Israeli settlements",
  "What do my sources say about the Suez Canal nationalisation?",
  "Who financed the Aswan High Dam, and what happened?",
  "Where do my sources disagree with each other?",
];

export default function AskPage() {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [q, setQ] = useState("");
  const [tagId, setTagId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const [a, t] = await Promise.all([
      fetch("/api/ask", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/tags", { cache: "no-store" }).then((r) => r.json()),
    ]);
    setQuestions(a.questions ?? []);
    setTags(t.tags ?? []);
    return (a.questions ?? []) as Question[];
  }, []);

  // Poll only while something is still being answered.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const qs = await load();
      const waiting = qs.some((x) => x.state === "pending");
      timer.current = setTimeout(tick, waiting ? 2000 : 15000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const ask = async (text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text, tagId: tagId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not ask that.");
      setNote(
        data.passages === 0
          ? "Nothing in your library seems to touch this — the answer will say so."
          : `Reading ${data.passages} passage${data.passages === 1 ? "" : "s"}…`
      );
      setQ("");
      void load();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Ask</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Put a question to everything you have collected. Answers are built only from your own
          sources, and every sentence carries the quote it rests on — so you can use one in your
          writing without checking it twice.
        </p>
      </div>

      <Card>
        <textarea
          className={`${inputClass} min-h-24`}
          placeholder="Tell me everything you know about…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask(q);
          }}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            className={`${inputClass} max-w-[14rem]`}
            value={tagId}
            onChange={(e) => setTagId(e.target.value ? Number(e.target.value) : "")}
          >
            <option value="">Every topic</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                Only {t.name}
              </option>
            ))}
          </select>
          <Button variant="primary" disabled={busy || !q.trim()} onClick={() => void ask(q)}>
            {busy ? "Asking…" : "Ask"}
          </Button>
          <span className="text-xs text-[var(--color-muted)]">⌘/Ctrl + Enter</span>
        </div>

        {questions.length === 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => setQ(s)}
                className="rounded-full border border-[var(--color-rule)] px-3 py-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {note && <p className="mt-3 text-sm text-[var(--color-accent)]">{note}</p>}
      </Card>

      {questions.length === 0 ? (
        <Empty title="Nothing asked yet" hint="Your questions and their answers stay here." />
      ) : (
        questions.map((item) => <Answer key={item.id} item={item} onDelete={load} />)
      )}
    </div>
  );
}

function Answer({ item, onDelete }: { item: Question; onDelete: () => void }) {
  const evidence = JSON.parse(item.evidence || "{}") as {
    cited?: number[];
    considered?: number;
    followUps?: string[];
    passages?: { id: number; quote: string; entity: string; citation: string }[];
  };
  const quotes = new Map((evidence.passages ?? []).map((p) => [p.id, p]));

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="font-serif text-lg font-semibold" dir={dirOf(item.question)}>
          {item.question}
        </h2>
        <div className="flex shrink-0 items-center gap-2 text-xs text-[var(--color-muted)]">
          {item.tag_name && (
            <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[var(--color-accent)]">
              {item.tag_name}
            </span>
          )}
          <span>{item.created_at.slice(0, 16)}</span>
          <button
            className="hover:text-red-700"
            onClick={async () => {
              await fetch(`/api/ask?id=${item.id}`, { method: "DELETE" });
              onDelete();
            }}
          >
            Remove
          </button>
        </div>
      </div>

      {item.state === "pending" ? (
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          Reading your sources… this stays here if you navigate away.
        </p>
      ) : (
        <>
          <div className="prose-entry mt-3" dir={dirOf(item.answer_md ?? "")}>
            <Markdown text={item.answer_md ?? ""} quotes={quotes} />
          </div>
          <p className="mt-4 border-t border-[var(--color-rule)] pt-2 text-xs text-[var(--color-muted)]">
            Drawn from {evidence.cited?.length ?? 0} passage
            {(evidence.cited?.length ?? 0) === 1 ? "" : "s"}
            {evidence.considered ? ` of ${evidence.considered} considered` : ""}. Numbers link to the
            quote behind each claim.
          </p>
          {evidence.followUps && evidence.followUps.length > 0 && (
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Your sources would also answer: {evidence.followUps.join(" · ")}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/** Light Markdown with the citation markers turned into links to the evidence. */
function Markdown({
  text,
  quotes,
}: {
  text: string;
  quotes: Map<number, { quote: string; entity: string; citation: string }>;
}) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/).filter(Boolean);
  const [open, setOpen] = useState<number | null>(null);
  let n = 0;
  const seen = new Map<number, number>();
  const showing = open === null ? undefined : quotes.get(open);

  const inline = (s: string) =>
    s.split(/(\[\[m:\d+\]\]|\*\*[^*]+\*\*)/g).map((part, i) => {
      const cite = /^\[\[m:(\d+)\]\]$/.exec(part);
      if (cite) {
        const id = Number(cite[1]);
        if (!seen.has(id)) seen.set(id, ++n);
        const source = quotes.get(id);
        // The quote travels with the answer, so this opens whether or not the
        // passage still exists. It used to link at `/search?q=#m<id>` — an
        // empty search and an anchor that is not on that page, so clicking a
        // citation did nothing at all.
        return (
          <button
            key={i}
            type="button"
            onClick={() => setOpen(open === id ? null : id)}
            title={source ? source.citation : "This passage is no longer in the library"}
            className={`mx-0.5 cursor-pointer rounded px-1 align-super text-[0.62em] font-sans font-semibold transition ${
              open === id
                ? "bg-[var(--color-accent)] text-white"
                : "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
            }`}
          >
            {seen.get(id)}
          </button>
        );
      }
      if (part.startsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
      return <span key={i}>{part}</span>;
    });

  return (
    <>
      {blocks.map((b, i) => {
        const h = /^(#{1,4})\s+(.*)$/.exec(b);
        if (h) return <h3 key={i}>{inline(h[2])}</h3>;
        if (b.split("\n").every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={i}>
              {b.split("\n").map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{inline(b.replace(/\n/g, " "))}</p>;
      })}

      {open !== null && (
        <aside className="not-prose mt-3 rounded border border-[var(--color-accent)] bg-[var(--color-accent-soft)]/40 p-3 text-sm">
          {showing ? (
            <>
              <p className="font-medium">
                {seen.get(open)}. {showing.citation}
              </p>
              <blockquote
                className="mt-1 border-l-2 border-[var(--color-accent)] pl-3 italic"
                dir={dirOf(showing.quote)}
              >
                “{showing.quote}”
              </blockquote>
            </>
          ) : (
            <p className="text-[var(--color-muted)]">
              This answer was written before quotes were kept with it, and the passage it cited has
              since been re-read. Ask again to get a citable answer.
            </p>
          )}
        </aside>
      )}
    </>
  );
}
