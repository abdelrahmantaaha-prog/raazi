"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, Empty, inputClass } from "../components/ui";
import { dirOf } from "@/lib/dir";

interface StudyCard {
  id: number;
  kind: "card" | "quiz";
  front: string;
  back: string;
  distractors: string;
  entity_id: number | null;
  entity: string | null;
  source: string | null;
  quote: string | null;
  locator: string | null;
  box: number;
  reviews: number;
}

interface Counts {
  kind: string;
  total: number;
  due: number;
  unseen: number;
}

export default function StudyPage() {
  const [mode, setMode] = useState<"card" | "quiz">("card");
  const [tagId, setTagId] = useState<number | "">("");
  const [tags, setTags] = useState<{ id: number; name: string }[]>([]);
  const [queue, setQueue] = useState<StudyCard[]>([]);
  const [counts, setCounts] = useState<Counts[]>([]);
  const [i, setI] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [session, setSession] = useState({ right: 0, wrong: 0 });

  const load = useCallback(async () => {
    const [s, t] = await Promise.all([
      fetch(`/api/study?mode=${mode}${tagId ? `&tag=${tagId}` : ""}`, { cache: "no-store" }).then((r) =>
        r.json()
      ),
      fetch("/api/tags", { cache: "no-store" }).then((r) => r.json()),
    ]);
    setQueue(s.due ?? []);
    setCounts(s.counts ?? []);
    setTags(t.tags ?? []);
    setI(0);
    setRevealed(false);
    setPicked(null);
  }, [mode, tagId]);

  useEffect(() => {
    void load();
  }, [load]);

  const card = queue[i];

  const answer = async (correct: boolean) => {
    if (!card) return;
    setSession((s) => ({ right: s.right + (correct ? 1 : 0), wrong: s.wrong + (correct ? 0 : 1) }));
    await fetch("/api/study", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "review", cardId: card.id, correct }),
    });
    setRevealed(false);
    setPicked(null);
    setI((n) => n + 1);

    // The header counts were read once when the deck loaded, so they still
    // claimed everything was due after you had worked through it. Refreshed at
    // the end of the deck — not after every card, which would be a request per
    // answer for a number nobody is watching mid-run.
    if (i + 1 >= queue.length) {
      const s = await fetch(`/api/study?mode=${mode}${tagId ? `&tag=${tagId}` : ""}`, {
        cache: "no-store",
      }).then((r) => r.json());
      setCounts(s.counts ?? []);
    }
  };

  const generate = async () => {
    setBusy(true);
    setNote(null);
    const res = await fetch("/api/study", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "generate", tagId: tagId || undefined, limit: 24 }),
    });
    const data = await res.json();
    setNote(data.note ?? data.error);
    setBusy(false);
    setTimeout(() => void load(), 6000);
  };

  const total = counts.reduce((n, c) => n + c.total, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-semibold">Study</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Cards built from your own sources. Every one shows the passage it came from, so a card
            you doubt can be checked rather than trusted.
          </p>
        </div>
        {counts.length > 0 && (
          <div className="flex gap-5 text-sm">
            {counts.map((c) => (
              <div key={c.kind}>
                <div className="font-serif text-xl font-semibold">{c.due}</div>
                <div className="text-xs text-[var(--color-muted)]">
                  {c.kind === "quiz" ? "quiz" : "cards"} due of {c.total}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex overflow-hidden rounded border border-[var(--color-rule)]">
            {(["card", "quiz"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className="px-3 py-1.5 text-sm"
                style={
                  mode === m
                    ? { background: "var(--color-ink)", color: "white" }
                    : { color: "var(--color-muted)" }
                }
              >
                {m === "card" ? "Flashcards" : "Quiz"}
              </button>
            ))}
          </span>
          <select
            className={`${inputClass} max-w-[13rem]`}
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
          <Button onClick={generate} disabled={busy}>
            {busy ? "Building…" : total === 0 ? "Make me some cards" : "Make more"}
          </Button>
          {(session.right > 0 || session.wrong > 0) && (
            <span className="text-sm text-[var(--color-muted)]">
              This session: {session.right} right, {session.wrong} wrong
            </span>
          )}
        </div>
        {note && <p className="mt-3 text-sm text-[var(--color-accent)]">{note}</p>}
      </Card>

      {!card ? (
        <Empty
          title={
            total === 0
              ? "No cards yet"
              : queue.length === 0
                ? "Nothing due right now"
                : "That's the lot for now"
          }
          hint={
            total === 0
              ? "Build a set from your sources above — they are made from the quotes you have already collected."
              : "Cards you got right come back later; ones you missed come back sooner. Check again tomorrow, or make more."
          }
        />
      ) : (
        <Card className="min-h-[22rem]">
          <div className="mb-3 flex items-center justify-between text-xs text-[var(--color-muted)]">
            <span>
              {i + 1} of {queue.length}
              {card.entity && (
                <>
                  {" · "}
                  <Link href={`/pedia/${card.entity_id}`} className="hover:text-[var(--color-accent)]">
                    {card.entity}
                  </Link>
                </>
              )}
            </span>
            <span>
              {card.reviews === 0 ? "new" : `seen ${card.reviews}×`} · box {card.box}
            </span>
          </div>

          <p className="font-serif text-xl leading-snug" dir={dirOf(card.front)}>
            {card.front}
          </p>

          {card.kind === "quiz" ? (
            // Keyed, so each card gets a fresh component and therefore its own
            // shuffled options. Without this the options are built once, on the
            // first quiz card, and every card after it offers that card's four
            // answers — none of which is the right one.
            <QuizBody key={card.id} card={card} picked={picked} onPick={setPicked} />
          ) : (
            <div className="mt-6">
              {revealed ? (
                <p className="font-serif text-lg" dir={dirOf(card.back)}>
                  {card.back}
                </p>
              ) : (
                <Button onClick={() => setRevealed(true)}>Show the answer</Button>
              )}
            </div>
          )}

          {(revealed || picked) && (
            <>
              {card.quote && (
                <blockquote
                  className="mt-5 border-l-2 border-[var(--color-rule)] pl-3 text-sm italic text-[var(--color-muted)]"
                  dir={dirOf(card.quote)}
                >
                  “{card.quote}”
                  {card.source && (
                    <span className="mt-1 block not-italic">
                      — {[card.source, card.locator].filter(Boolean).join(", ")}
                    </span>
                  )}
                </blockquote>
              )}

              <div className="mt-6 flex flex-wrap gap-2">
                {card.kind === "quiz" ? (
                  <Button variant="primary" onClick={() => answer(picked === card.back)}>
                    Next
                  </Button>
                ) : (
                  <>
                    <Button onClick={() => answer(false)}>I did not know it</Button>
                    <Button variant="primary" onClick={() => answer(true)}>
                      I knew it
                    </Button>
                  </>
                )}
                <button
                  className="text-sm text-[var(--color-muted)] hover:text-red-700"
                  onClick={async () => {
                    await fetch(`/api/study?id=${card.id}`, { method: "DELETE" });
                    setI((n) => n + 1);
                    setRevealed(false);
                    setPicked(null);
                  }}
                >
                  This card is wrong — remove it
                </button>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function QuizBody({
  card,
  picked,
  onPick,
}: {
  card: StudyCard;
  picked: string | null;
  onPick: (v: string) => void;
}) {
  const [options] = useState(() => {
    const wrong = JSON.parse(card.distractors || "[]") as string[];
    // Deterministic per card, so the right answer is not always in the same
    // place but does not jump around on a re-render either.
    const all = [card.back, ...wrong];
    let seed = card.id;
    for (let i = all.length - 1; i > 0; i--) {
      seed = (seed * 9301 + 49297) % 233280;
      const j = seed % (i + 1);
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all;
  });

  return (
    <div className="mt-5 space-y-2">
      {options.map((opt) => {
        const isRight = opt === card.back;
        const chosen = picked === opt;
        return (
          <button
            key={opt}
            disabled={picked !== null}
            onClick={() => onPick(opt)}
            className="block w-full rounded border px-3 py-2 text-left text-sm transition disabled:cursor-default"
            style={{
              borderColor:
                picked === null
                  ? "var(--color-rule)"
                  : isRight
                    ? "#2f6b5b"
                    : chosen
                      ? "#a33b3b"
                      : "var(--color-rule)",
              background:
                picked === null
                  ? "white"
                  : isRight
                    ? "#eef6f3"
                    : chosen
                      ? "#fbeeee"
                      : "white",
              opacity: picked !== null && !isRight && !chosen ? 0.55 : 1,
            }}
            dir={dirOf(opt)}
          >
            {opt}
            {picked !== null && isRight && <span className="ml-2 text-xs text-[#2f6b5b]">correct</span>}
          </button>
        );
      })}
    </div>
  );
}
