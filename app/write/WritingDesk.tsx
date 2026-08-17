"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { dirOf } from "@/lib/dir";
import { Button } from "../components/ui";
import { Editor } from "./Editor";

interface Reference {
  id: number;
  origin: "library" | "outside";
  text: string;
  author: string | null;
  title: string | null;
  year: string | null;
  locator: string | null;
  url: string | null;
}

interface DraftSummary {
  id: number;
  title: string;
  updated_at: string;
  words: number;
  notes: number;
}

interface Note {
  id: number;
  kind: string;
  text: string;
  citation: string | null;
  entity_id: number | null;
  source_id: number | null;
}

interface Hit {
  id: number;
  quote: string;
  claim: string | null;
  context: string | null;
  entity: string;
  entity_id: number;
  source_id: number;
  chunk_id: number;
  source_title: string;
  locator: string;
  citation: string;
}

interface EntryHit {
  id: number;
  canonical_name: string;
  type: string;
  snippet: string;
}

interface Verdict {
  claim: string;
  verdict: "supported" | "partly" | "unsupported" | "contradicted";
  note?: string;
  citations: { id: number; quote: string; source: string; locator: string }[];
}

interface Report {
  claims: Verdict[];
  checkedAt: string;
}

const VERDICT: Record<Verdict["verdict"], { label: string; className: string }> = {
  supported: { label: "Supported", className: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  partly: { label: "Partly", className: "bg-amber-50 text-amber-800 border-amber-200" },
  contradicted: { label: "Contradicted", className: "bg-red-50 text-red-800 border-red-200" },
  unsupported: {
    label: "Not in your sources",
    className: "bg-[var(--color-accent-soft)] text-[var(--color-muted)] border-[var(--color-rule)]",
  },
};

/**
 * Somewhere to write, with your own library open beside it.
 *
 * The pane on the right searches and collects; it contains no model at all. No
 * suggested phrasings, no "related passages you might have missed", no
 * autocomplete. Those things are not neutral — a suggestion you decline still
 * changes the sentence you write next — and the whole reason to keep a library
 * of primary sources is to write from them yourself.
 *
 * The single exception is the fact-check, which runs when you ask for it, on a
 * draft you have already written, and reports rather than edits. Checking what
 * you wrote against your sources is the opposite of having it written for you.
 */
export function WritingDesk({ initial }: { initial: DraftSummary[] }) {
  const [drafts, setDrafts] = useState<DraftSummary[]>(initial);
  const [id, setId] = useState<number | null>(initial[0]?.id ?? null);
  const [title, setTitle] = useState(initial[0]?.title ?? "");
  const [body, setBody] = useState("");
  const [refs, setRefs] = useState<Reference[]>([]);
  const [citeOpen, setCiteOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");

  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [entryHits, setEntryHits] = useState<EntryHit[]>([]);
  const [searching, setSearching] = useState(false);

  const [report, setReport] = useState<Report | null>(null);
  const [checking, setChecking] = useState(false);
  const [pane, setPane] = useState<"sources" | "check">("sources");

  const editor = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- loading a draft ---------------------------------------------------

  const open = useCallback(async (draftId: number) => {
    setLoaded(false);
    const res = await fetch(`/api/drafts/${draftId}`, { cache: "no-store" });
    const data = await res.json();
    if (!data.draft) return;
    setId(draftId);
    setTitle(data.draft.title);
    setBody(data.draft.body_html || (data.draft.body_md ? `<p>${escapeHtml(data.draft.body_md)}</p>` : ""));
    setRefs(data.citations ?? []);
    setNotes(data.notes ?? []);
    setReport(data.draft.check_json ? JSON.parse(data.draft.check_json) : null);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (id !== null) void open(id);
    else setLoaded(true);
  }, [/* first draft only */ open]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- saving ------------------------------------------------------------

  // Only after the draft is in the box. Autosaving before then would write an
  // empty body over the file you just opened.
  useEffect(() => {
    if (!loaded || id === null) return;
    setSaved("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await fetch(`/api/drafts/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body_html: body }),
      });
      setSaved("saved");
      setDrafts((ds) =>
        ds.map((d) => (d.id === id ? { ...d, title, words: countWords(body) } : d))
      );
    }, 700);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [title, body, id, loaded]);

  const newDraft = async () => {
    const res = await fetch("/api/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Untitled" }),
    });
    const data = await res.json();
    setDrafts(data.drafts ?? []);
    await open(data.id);
  };

  const removeDraft = async (draftId: number, name: string) => {
    if (!confirm(`Delete "${name}"? The draft and its gathered material go with it.`)) return;
    await fetch(`/api/drafts/${draftId}`, { method: "DELETE" });
    const rest = drafts.filter((d) => d.id !== draftId);
    setDrafts(rest);
    if (rest.length) await open(rest[0].id);
    else {
      setId(null);
      setBody("");
      setTitle("");
      setNotes([]);
    }
  };

  // ---- the AI-free pane --------------------------------------------------

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      setEntryHits([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/drafts/search?q=${encodeURIComponent(term)}`, {
          cache: "no-store",
        });
        const data = await res.json();
        setHits(data.quotes ?? []);
        setEntryHits(data.entries ?? []);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const keep = async (hit: Hit) => {
    if (id === null) return;
    const res = await fetch(`/api/drafts/${id}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: hit.quote,
        kind: "quote",
        citation: hit.citation,
        entityId: hit.entity_id,
        mentionId: hit.id,
        chunkId: hit.chunk_id,
        sourceId: hit.source_id,
      }),
    });
    setNotes((await res.json()).notes ?? []);
  };

  const drop = async (noteId: number) => {
    if (id === null) return;
    const res = await fetch(`/api/drafts/${id}/notes?note=${noteId}`, { method: "DELETE" });
    setNotes((await res.json()).notes ?? []);
  };

  /** Puts a block quote where the cursor is, in the editor's own markup. */
  const insert = (html: string) => {
    const box = document.querySelector<HTMLElement>('[role="textbox"][aria-label="Draft"]');
    if (!box) return;
    box.focus();
    document.execCommand("insertHTML", false, html);
    setBody(box.innerHTML);
  };

  const insertQuote = (quote: string, citation: string) =>
    insert(
      `<blockquote>${escapeHtml(quote)}</blockquote>` +
        `<p><em>${escapeHtml(citation)}</em></p><p><br></p>`
    );

  // ---- references --------------------------------------------------------

  /**
   * Adds a reference and cites it where the cursor is.
   *
   * A citation from the library carries its quote, so the note can be checked
   * later against the passage it came from; one from outside carries whatever
   * you typed. Both end up in the same numbered sequence, because a reader of
   * the finished piece does not care which of your bookshelves a book was on.
   */
  const cite = async (ref: Partial<Reference> & { quote?: string; sourceId?: number; mentionId?: number }) => {
    if (id === null) return;
    const res = await fetch(`/api/drafts/${id}/citations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ref),
    });
    const data = (await res.json()) as { citations: Reference[] };
    setRefs(data.citations ?? []);

    const index = (data.citations ?? []).length - 1;
    if (index >= 0) {
      insert(
        `<span data-note="${index}" contenteditable="false" ` +
          `style="vertical-align:super;font-size:0.72em;color:var(--color-accent);padding:0 1px">` +
          `[${index + 1}]</span>&nbsp;`
      );
    }
    setCiteOpen(false);
  };

  const dropRef = async (refId: number) => {
    if (id === null) return;
    const res = await fetch(`/api/drafts/${id}/citations?citation=${refId}`, { method: "DELETE" });
    setRefs((await res.json()).citations ?? []);
  };

  // ---- the one thing that does call a model ------------------------------

  const check = async () => {
    if (id === null) return;
    setChecking(true);
    setPane("check");
    await fetch(`/api/drafts/${id}/check`, { method: "POST" });

    const poll = async () => {
      const res = await fetch(`/api/drafts/${id}/check`, { cache: "no-store" });
      const data = await res.json();
      if (data.running) {
        setTimeout(poll, 1500);
        return;
      }
      setReport(data.report);
      setChecking(false);
    };
    setTimeout(poll, 1200);
  };

  const counts = report
    ? report.claims.reduce<Record<string, number>>((acc, c) => {
        acc[c.verdict] = (acc[c.verdict] ?? 0) + 1;
        return acc;
      }, {})
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-semibold">Writing</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Your sources on the right, nothing writing over your shoulder. The only thing that reads
            what you wrote is the fact-check, and only when you ask.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="rounded border border-[var(--color-rule)] bg-white px-2 py-1.5 text-sm"
            value={id ?? ""}
            onChange={(e) => void open(Number(e.target.value))}
          >
            {drafts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title} · {d.words} words
              </option>
            ))}
            {drafts.length === 0 && <option value="">No drafts</option>}
          </select>
          <Button onClick={newDraft}>New draft</Button>
        </div>
      </div>

      {citeOpen && <CiteDialog onCancel={() => setCiteOpen(false)} onAdd={cite} />}

      {id === null ? (
        <div className="rounded-lg border border-dashed border-[var(--color-rule)] p-10 text-center">
          <p className="text-sm text-[var(--color-muted)]">
            Nothing started yet. A draft is just a page — the library comes with it.
          </p>
          <div className="mt-3">
            <Button variant="primary" onClick={newDraft}>
              Start writing
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_23rem]">
          {/* ---------------- the draft ---------------- */}
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-1 font-serif text-xl font-semibold hover:border-[var(--color-rule)] focus:border-[var(--color-rule)] focus:outline-none"
                aria-label="Draft title"
              />
              <span className="shrink-0 text-xs tabular-nums text-[var(--color-muted)]">
                {countWords(body)} words
                {saved === "saving" ? " · saving…" : saved === "saved" ? " · saved" : ""}
              </span>
              <button
                onClick={() => removeDraft(id, title)}
                className="shrink-0 text-xs text-[var(--color-muted)] hover:text-red-700"
              >
                Delete
              </button>
            </div>

            <Editor
              html={body}
              citations={refs}
              onChange={setBody}
              onCite={() => setCiteOpen(true)}
              dir={dirOf(stripTags(body)) as "ltr" | "rtl"}
            />

            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={check} disabled={checking || !body.trim()}>
                {checking ? "Checking…" : "Fact-check draft"}
              </Button>
              <a
                href={`/api/drafts/${id}/export`}
                className="rounded border border-[var(--color-rule)] bg-white px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-accent-soft)]"
                title="Download as a Word document, with your citations as real footnotes"
              >
                Export .docx
              </a>
              <span className="text-xs text-[var(--color-muted)]">
                The check reads your draft against your library and reports. It never edits what you
                wrote.
              </span>
            </div>

            {refs.length > 0 && (
              <div className="rounded-lg border border-[var(--color-rule)] bg-white p-3">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">
                  References
                </h3>
                <ol className="space-y-1 text-sm">
                  {refs.map((r, i) => (
                    <li key={r.id} className="flex items-baseline gap-2">
                      <span className="tabular-nums text-[var(--color-muted)]">[{i + 1}]</span>
                      <span className="min-w-0 flex-1" dir={dirOf(r.text)}>
                        {r.text}
                        {r.origin === "outside" && (
                          <span className="ml-1.5 text-xs text-[var(--color-muted)]">
                            · not in your library
                          </span>
                        )}
                      </span>
                      <button
                        onClick={() => void dropRef(r.id)}
                        className="shrink-0 text-xs text-[var(--color-muted)] hover:text-red-700"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ol>
                <p className="mt-2 text-[0.68rem] text-[var(--color-muted)]">
                  These export as Word footnotes, numbered by where they first appear.
                </p>
              </div>
            )}
          </div>

          {/* ---------------- the pane ---------------- */}
          <div className="space-y-3">
            <div className="flex overflow-hidden rounded border border-[var(--color-rule)] text-sm">
              {(["sources", "check"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPane(p)}
                  className={`flex-1 px-3 py-1.5 ${
                    pane === p
                      ? "bg-[var(--color-ink)] text-white"
                      : "bg-white text-[var(--color-muted)]"
                  }`}
                >
                  {p === "sources" ? `Sources${notes.length ? ` · ${notes.length}` : ""}` : "Check"}
                </button>
              ))}
            </div>

            {pane === "sources" && (
              <>
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search your library…"
                  className="w-full rounded border border-[var(--color-rule)] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                />
                <p className="text-[0.7rem] text-[var(--color-muted)]">
                  Word matching over every passage and entry. No model involved.
                </p>

                {notes.length > 0 && (
                  <div className="rounded-lg border border-[var(--color-rule)] bg-white p-3">
                    <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">
                      Gathered
                    </h3>
                    <ul className="space-y-2">
                      {notes.map((n) => (
                        <li key={n.id} className="rounded border border-[var(--color-rule)] p-2 text-sm">
                          <p className="italic" dir={dirOf(n.text)}>
                            “{truncate(n.text, 180)}”
                          </p>
                          {n.citation && (
                            <p className="mt-1 text-xs text-[var(--color-muted)]">{n.citation}</p>
                          )}
                          <div className="mt-1.5 flex gap-3 text-xs">
                            <button
                              className="text-[var(--color-accent)] hover:underline"
                              onClick={() =>
                                insertQuote(n.text, n.citation ?? "")
                              }
                            >
                              Insert
                            </button>
                            <button
                              className="text-[var(--color-muted)] hover:underline"
                              onClick={() => void drop(n.id)}
                            >
                              Remove
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {searching && <p className="text-sm text-[var(--color-muted)]">Searching…</p>}

                {entryHits.length > 0 && (
                  <div className="rounded-lg border border-[var(--color-rule)] bg-white p-3">
                    <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">
                      Entries
                    </h3>
                    <ul className="space-y-1.5 text-sm">
                      {entryHits.map((e) => (
                        <li key={e.id}>
                          <Link
                            href={`/pedia/${e.id}`}
                            target="_blank"
                            className="font-medium hover:text-[var(--color-accent)]"
                          >
                            {e.canonical_name}
                          </Link>
                          <span className="text-[var(--color-muted)]"> — {clean(e.snippet)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {hits.length > 0 && (
                  <ul className="space-y-2">
                    {hits.map((h) => (
                      <li
                        key={h.id}
                        className="rounded-lg border border-[var(--color-rule)] bg-white p-3 text-sm"
                      >
                        <p className="italic" dir={dirOf(h.quote)}>
                          “{truncate(h.quote, 240)}”
                        </p>
                        {h.context && (
                          <p className="mt-1 text-xs text-[var(--color-muted)]">
                            <span className="font-medium">Refers to:</span> {h.context}
                          </p>
                        )}
                        <p className="mt-1 text-xs text-[var(--color-muted)]">{h.citation}</p>
                        <div className="mt-1.5 flex gap-3 text-xs">
                          <button
                            className="text-[var(--color-accent)] hover:underline"
                            onClick={() => void keep(h)}
                          >
                            Keep
                          </button>
                          <button
                            className="text-[var(--color-muted)] hover:underline"
                            onClick={() => insertQuote(h.quote, h.citation)}
                          >
                            Insert
                          </button>
                          <button
                            className="text-[var(--color-muted)] hover:underline"
                            title="Add this to your references and cite it where the cursor is"
                            onClick={() =>
                              void cite({
                                origin: "library",
                                text: h.citation,
                                title: h.source_title,
                                locator: h.locator,
                                quote: h.quote,
                                sourceId: h.source_id,
                                mentionId: h.id,
                              })
                            }
                          >
                            Cite
                          </button>
                          <Link
                            href={`/pedia/${h.entity_id}`}
                            target="_blank"
                            className="text-[var(--color-muted)] hover:underline"
                          >
                            {h.entity}
                          </Link>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {!searching && q.trim().length >= 2 && hits.length === 0 && entryHits.length === 0 && (
                  <p className="text-sm text-[var(--color-muted)]">
                    Nothing in the library matches those words.
                  </p>
                )}
              </>
            )}

            {pane === "check" && (
              <div className="space-y-3">
                {checking && (
                  <p className="text-sm text-[var(--color-muted)]">
                    Reading the draft against your sources…
                  </p>
                )}

                {!checking && !report && (
                  <p className="text-sm text-[var(--color-muted)]">
                    Nothing checked yet. The check reads each factual claim in the draft and says
                    whether your own sources bear it out — supported, partly, contradicted, or simply
                    not covered. It does not rewrite anything.
                  </p>
                )}

                {report && counts && (
                  <>
                    <p className="text-xs text-[var(--color-muted)]">
                      {report.claims.length} claim(s) · {counts.supported ?? 0} supported ·{" "}
                      {counts.partly ?? 0} partly · {counts.contradicted ?? 0} contradicted ·{" "}
                      {counts.unsupported ?? 0} not in your sources
                    </p>
                    <ul className="space-y-2">
                      {[...report.claims]
                        .sort((a, b) => rank(a.verdict) - rank(b.verdict))
                        .map((c, i) => (
                          <li
                            key={i}
                            className={`rounded-lg border p-3 text-sm ${VERDICT[c.verdict].className}`}
                          >
                            <div className="text-[0.68rem] font-medium uppercase tracking-[0.1em]">
                              {VERDICT[c.verdict].label}
                            </div>
                            <p className="mt-1" dir={dirOf(c.claim)}>
                              {c.claim}
                            </p>
                            {c.note && <p className="mt-1 text-xs opacity-90">{c.note}</p>}
                            {c.citations?.length > 0 && (
                              <ul className="mt-1.5 space-y-1 text-xs opacity-90">
                                {c.citations.map((q) => (
                                  <li key={q.id}>
                                    “{truncate(q.quote, 150)}” — {q.source}
                                    {q.locator ? `, ${q.locator}` : ""}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Worst news first — that is the part you act on. */
function rank(v: Verdict["verdict"]): number {
  return { contradicted: 0, partly: 1, unsupported: 2, supported: 3 }[v];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The editor stores HTML; direction and word counts want the words. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/s+/g, " ").trim();
}

function countWords(s: string): number {
  const t = stripTags(s).trim();
  return t ? t.split(/\s+/).length : 0;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function clean(snippet: string): string {
  return snippet.replace(/<<|>>/g, "");
}

/**
 * A reference from outside the library.
 *
 * Half of what anyone cites is a book they read somewhere else, and a
 * bibliography that could only hold ingested sources would be no use for real
 * writing. These sit in the same numbered sequence as citations drawn from your
 * own material — the reader of the finished piece does not care which shelf a
 * book came off — but they are marked in the reference list, because *you* care
 * which claims you can check against a passage and which you cannot.
 */
function CiteDialog({
  onCancel,
  onAdd,
}: {
  onCancel: () => void;
  onAdd: (ref: { origin: "outside"; author?: string; title?: string; year?: string; locator?: string; url?: string }) => void;
}) {
  const [author, setAuthor] = useState("");
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [locator, setLocator] = useState("");
  const [url, setUrl] = useState("");

  const preview = [author, title, year, locator].filter((s) => s.trim()).join(", ");

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 p-6 pt-24"
      onMouseDown={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg border border-[var(--color-rule)] bg-white p-4 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="font-serif text-lg font-semibold">Add a reference</h3>
        <p className="mt-0.5 text-xs text-[var(--color-muted)]">
          For something not in your library. To cite your own sources, use <em>Cite</em> beside a
          search result.
        </p>

        <div className="mt-3 space-y-2">
          {(
            [
              ["Author", author, setAuthor, "Klein, Naomi"],
              ["Title", title, setTitle, "The Shock Doctrine"],
              ["Year", year, setYear, "2007"],
              ["Page or locator", locator, setLocator, "p. 142"],
              ["URL", url, setUrl, "https://…"],
            ] as const
          ).map(([label, value, set, hint]) => (
            <label key={label} className="block">
              <span className="text-xs text-[var(--color-muted)]">{label}</span>
              <input
                value={value}
                onChange={(e) => set(e.target.value)}
                placeholder={hint}
                className="mt-0.5 w-full rounded border border-[var(--color-rule)] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              />
            </label>
          ))}
        </div>

        {preview && (
          <p className="mt-3 rounded bg-[var(--color-accent-soft)] px-2 py-1.5 text-xs">
            <span className="text-[var(--color-muted)]">Footnote will read: </span>
            {preview}
            {url.trim() ? `. ${url.trim()}` : ""}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!preview && !url.trim()}
            onClick={() => onAdd({ origin: "outside", author, title, year, locator, url })}
          >
            Add and cite
          </Button>
        </div>
      </div>
    </div>
  );
}
