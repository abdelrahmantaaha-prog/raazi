"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { dirOf } from "@/lib/dir";
import { formatDateTime, relativeDate } from "@/lib/dates";
import { Button } from "../components/ui";
import { Modal } from "../components/Modal";
import { Editor } from "./Editor";
import { citationMarker, renumberDom, renumberHtml } from "./citations";
import { LibraryCite, type LibraryPick } from "./LibraryCite";
import type { CitablePassage } from "@/lib/cite-search";

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
export function WritingDesk({
  initial,
  openDraft,
}: {
  initial: DraftSummary[];
  /** A draft asked for by id — `/write?draft=ID`, as the Ideas page links. */
  openDraft?: number | null;
}) {
  const [drafts, setDrafts] = useState<DraftSummary[]>(initial);
  const first = openDraft ?? initial[0]?.id ?? null;
  const [id, setId] = useState<number | null>(first);
  const [title, setTitle] = useState(initial.find((d) => d.id === first)?.title ?? "");
  const [body, setBody] = useState("");
  const [refs, setRefs] = useState<Reference[]>([]);
  const [citeOpen, setCiteOpen] = useState(false);
  /** The library search opened from the editor's toolbar. */
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  /** What went wrong with the last request from the pane, if anything. */
  const [paneError, setPaneError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [entryHits, setEntryHits] = useState<EntryHit[]>([]);
  const [searching, setSearching] = useState(false);

  const [report, setReport] = useState<Report | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [pane, setPane] = useState<"sources" | "check">("sources");

  // ---- logging a quote by hand -------------------------------------------
  //
  // The shelf used to fill only from the pane's search. A quote you have in
  // front of you — copied from a PDF, a printout, a page open in the browser —
  // had no way on except through the editor. Now it is pasted here and tied to
  // a citation: a source from the library, chosen by name, or a reference
  // typed for something read elsewhere.
  const [logOpen, setLogOpen] = useState(false);
  const [logText, setLogText] = useState("");
  const [logCite, setLogCite] = useState("");
  const [logSource, setLogSource] = useState<{ id: number; title: string } | null>(null);
  const [sourceQ, setSourceQ] = useState("");
  const [library, setLibrary] = useState<{ id: number; title: string; author: string | null; year: string | null; outlet: string | null }[] | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The title and body as last written to disk, so a no-op is never saved. */
  const lastSaved = useRef<{ id: number | null; title: string; body: string }>({
    id: null,
    title: "",
    body: "",
  });
  /** The draft on screen, readable from callbacks that outlive a render. */
  const idRef = useRef<number | null>(first);
  idRef.current = id;
  /** The fact-check in flight, so switching drafts can cancel it. */
  const checkAbort = useRef<AbortController | null>(null);

  // ---- loading a draft ---------------------------------------------------

  const open = useCallback(async (draftId: number) => {
    // A check started on the previous draft must not write its report here.
    checkAbort.current?.abort();
    checkAbort.current = null;
    setChecking(false);
    setCheckError(null);
    setLoaded(false);
    setPaneError(null);
    try {
      const res = await fetch(`/api/drafts/${draftId}`, { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      if (!data?.draft) {
        setPaneError("That draft is no longer here.");
        return;
      }
      const citations: Reference[] = data.citations ?? [];
      const html = renumberHtml(
        data.draft.body_html || (data.draft.body_md ? `<p>${escapeHtml(data.draft.body_md)}</p>` : ""),
        citations
      );
      setId(draftId);
      setTitle(data.draft.title);
      setBody(html);
      setRefs(citations);
      setNotes(data.notes ?? []);
      setReport(data.draft.check_json ? JSON.parse(data.draft.check_json) : null);
      // Opening is not editing: what came off the disk is what is on the disk,
      // so the autosave below has nothing to do until you type.
      lastSaved.current = { id: draftId, title: data.draft.title, body: html };
      setSaved("idle");
    } catch (err) {
      setPaneError((err as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (id !== null) void open(id);
    else setLoaded(true);
  }, [/* first draft only */ open]); // eslint-disable-line react-hooks/exhaustive-deps

  // A different draft asked for by the URL while this page is already open.
  useEffect(() => {
    if (openDraft && openDraft !== idRef.current) void open(openDraft);
  }, [openDraft, open]);

  // A passage sent from the reader in another tab lands on the shelf while
  // this page is open. Coming back to the tab re-reads the shelf — only the
  // shelf, never the body, which may hold what you were typing.
  useEffect(() => {
    const refresh = async () => {
      const draftId = idRef.current;
      if (draftId === null || document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/drafts/${draftId}`, { cache: "no-store" });
        const data = res.ok ? await res.json() : null;
        if (data?.notes && idRef.current === draftId) setNotes(data.notes);
      } catch {
        /* the shelf as it was is still the shelf */
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  // ---- saving ------------------------------------------------------------

  // Only after the draft is in the box. Autosaving before then would write an
  // empty body over the file you just opened — and only when something has
  // actually changed, because a PUT of the same bytes still bumps the draft's
  // timestamp and shuffled the list every time one was opened.
  useEffect(() => {
    if (!loaded || id === null) return;
    const last = lastSaved.current;
    if (last.id === id && last.title === title && last.body === body) return;
    setSaved("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/drafts/${id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, body_html: body }),
        });
        if (!res.ok) throw new Error("save failed");
        lastSaved.current = { id, title, body };
        setSaved("saved");
        setDrafts((ds) =>
          ds.map((d) => (d.id === id ? { ...d, title, words: countWords(body) } : d))
        );
      } catch {
        // Said on the page rather than swallowed: "saved" on a draft that is
        // not would be the worst lie the desk could tell.
        setSaved("failed");
      }
    }, 700);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [title, body, id, loaded]);

  // Keep the in-text markers honest whenever the reference list changes:
  // the number each shows and the index the export reads are both derived from
  // the list's current order, never stored. Done on the live DOM so the caret
  // stays put, and emitted as a body change so it is saved.
  useEffect(() => {
    const box = document.querySelector<HTMLElement>('[role="textbox"][aria-label="Draft"]');
    if (!box) return;
    if (renumberDom(box, refs)) setBody(box.innerHTML);
  }, [refs]);

  /**
   * Reads one list out of a pane response, or throws with the server's reason.
   * An error response used to be read as an empty list, which wiped Gathered
   * and References off the screen while the in-text markers stayed.
   */
  const listFrom = async <T,>(res: Response, key: string): Promise<T[]> => {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!res.ok) throw new Error(data.error ?? "That didn't work.");
    return (data[key] as T[] | undefined) ?? [];
  };

  const newDraft = async () => {
    setPaneError(null);
    try {
      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Untitled" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start a draft.");
      setDrafts(data.drafts ?? []);
      await open(data.id);
    } catch (err) {
      setPaneError((err as Error).message);
    }
  };

  const removeDraft = async (draftId: number, name: string) => {
    if (!confirm(`Delete "${name}"? The draft and its gathered material go with it.`)) return;
    setPaneError(null);
    try {
      const res = await fetch(`/api/drafts/${draftId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error("Could not delete it.");
    } catch (err) {
      setPaneError((err as Error).message);
      return;
    }
    checkAbort.current?.abort();
    const rest = drafts.filter((d) => d.id !== draftId);
    setDrafts(rest);
    if (rest.length) await open(rest[0].id);
    else {
      setId(null);
      setBody("");
      setTitle("");
      setNotes([]);
      setRefs([]);
      setReport(null);
      setChecking(false);
      lastSaved.current = { id: null, title: "", body: "" };
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
        if (!res.ok) throw new Error("Search failed.");
        const data = await res.json();
        setHits(data.quotes ?? []);
        setEntryHits(data.entries ?? []);
      } catch (err) {
        setPaneError((err as Error).message);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const keep = async (hit: Hit) => {
    if (id === null) return;
    setPaneError(null);
    try {
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
      setNotes(await listFrom<Note>(res, "notes"));
    } catch (err) {
      setPaneError((err as Error).message);
    }
  };

  /** The library, for the source picker; fetched once, the first time the form opens. */
  const openLog = async () => {
    setLogOpen(true);
    if (library) return;
    try {
      const res = await fetch("/api/sources", { cache: "no-store" });
      const data = res.ok ? await res.json() : { sources: [] };
      setLibrary(
        (data.sources ?? []).map((s: { id: number; title: string; author: string | null; year: string | null; outlet: string | null }) => ({
          id: s.id,
          title: s.title,
          author: s.author,
          year: s.year,
          outlet: s.outlet,
        }))
      );
    } catch {
      setLibrary([]);
    }
  };

  const pickSource = (s: { id: number; title: string; author: string | null; year: string | null; outlet: string | null }) => {
    setLogSource({ id: s.id, title: s.title });
    // A citation the way the shelf's other lines read; editable before it is kept.
    setLogCite([s.author, s.title, s.outlet && s.outlet !== s.author ? s.outlet : null, s.year].filter(Boolean).join(", "));
    setSourceQ("");
  };

  const logQuote = async () => {
    if (id === null || !logText.trim()) return;
    setPaneError(null);
    try {
      const res = await fetch(`/api/drafts/${id}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: logText.trim(),
          kind: "quote",
          citation: logCite.trim() || undefined,
          sourceId: logSource?.id,
        }),
      });
      setNotes(await listFrom<Note>(res, "notes"));
      setLogText("");
      setLogCite("");
      setLogSource(null);
      setLogOpen(false);
    } catch (err) {
      setPaneError((err as Error).message);
    }
  };

  const drop = async (noteId: number) => {
    if (id === null) return;
    setPaneError(null);
    try {
      const res = await fetch(`/api/drafts/${id}/notes?note=${noteId}`, { method: "DELETE" });
      setNotes(await listFrom<Note>(res, "notes"));
    } catch (err) {
      setPaneError((err as Error).message);
    }
  };

  /**
   * Where the caret was in the draft when a dialog took the focus.
   *
   * Typing a search into a dialog moves the browser's selection into that box,
   * and focusing the draft again afterwards put the caret back at the start —
   * so a citation chosen from a dialog landed at the top of the piece. The
   * caret is remembered as the dialog opens and put back before inserting.
   */
  const caret = useRef<Range | null>(null);
  const rememberCaret = () => {
    const box = document.querySelector<HTMLElement>('[role="textbox"][aria-label="Draft"]');
    const sel = window.getSelection();
    caret.current =
      box && sel && sel.rangeCount && box.contains(sel.getRangeAt(0).commonAncestorContainer)
        ? sel.getRangeAt(0).cloneRange()
        : null;
  };

  /** Puts markup where the cursor is — or was, when a dialog took it — in the editor's own terms. */
  const insert = (html: string) => {
    const box = document.querySelector<HTMLElement>('[role="textbox"][aria-label="Draft"]');
    if (!box) return;
    box.focus();
    const range = caret.current;
    caret.current = null;
    if (range && box.contains(range.commonAncestorContainer)) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
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
  const cite = async (
    ref: Partial<Reference> & { quote?: string; sourceId?: number; mentionId?: number },
    opts: { withQuote?: string } = {}
  ) => {
    if (id === null) return;
    setPaneError(null);
    try {
      const res = await fetch(`/api/drafts/${id}/citations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ref),
      });
      const citations = await listFrom<Reference>(res, "citations");
      setRefs(citations);

      // The marker carries the reference's id; the number it shows is only
      // the id's position in the list today, and is redrawn when that moves.
      const index = citations.length - 1;
      if (index >= 0) {
        const marker = citationMarker(citations[index].id, index);
        // Quoted, the sentence goes in as a block quote with its marker at the end.
        insert(
          opts.withQuote ? `<blockquote>${escapeHtml(opts.withQuote)} ${marker}</blockquote><p><br></p>` : marker
        );
      }
      setCiteOpen(false);
      setLibraryOpen(false);
    } catch (err) {
      setPaneError((err as Error).message);
    }
  };

  /** A source or a passage chosen in the library search, cited at the cursor. */
  const citeFromLibrary = (pick: LibraryPick, withQuote: boolean) => {
    if (pick.kind === "source") {
      const s = pick.source;
      void cite({ origin: "library", text: s.citation, author: s.author, title: s.title, year: s.year, sourceId: s.id });
      return;
    }
    const p = pick.passage;
    void cite(
      {
        origin: "library",
        text: p.citation,
        author: p.author,
        title: p.title,
        year: p.year,
        locator: p.locator || null,
        quote: p.quote,
        sourceId: p.source_id,
      },
      withQuote ? { withQuote: p.quote } : {}
    );
  };

  /** A passage from the library search, onto the shelf beside the draft. */
  const keepPassage = async (p: CitablePassage): Promise<boolean> => {
    if (id === null) return false;
    setPaneError(null);
    try {
      const res = await fetch(`/api/drafts/${id}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: p.quote,
          kind: "quote",
          citation: p.citation,
          chunkId: p.chunk_id,
          sourceId: p.source_id,
        }),
      });
      setNotes(await listFrom<Note>(res, "notes"));
      return true;
    } catch (err) {
      setPaneError((err as Error).message);
      return false;
    }
  };

  const dropRef = async (refId: number) => {
    if (id === null) return;
    setPaneError(null);
    try {
      const res = await fetch(`/api/drafts/${id}/citations?citation=${refId}`, { method: "DELETE" });
      // The effect on `refs` renumbers every marker still in the text and
      // removes the ones that pointed at what was just dropped.
      setRefs(await listFrom<Reference>(res, "citations"));
    } catch (err) {
      setPaneError((err as Error).message);
    }
  };

  // ---- the one thing that does call a model ------------------------------

  /**
   * Starts a check and waits for its report.
   *
   * Bound to the draft it was started on: the poll carries that id and only
   * writes a report if that draft is still the one open — switching drafts
   * aborts it outright. Any failure clears "checking", which used to stick
   * for ever after one bad response.
   */
  const check = async () => {
    if (id === null) return;
    const draftId = id;
    checkAbort.current?.abort();
    const ctl = new AbortController();
    checkAbort.current = ctl;
    setChecking(true);
    setCheckError(null);
    setPane("check");

    try {
      const res = await fetch(`/api/drafts/${draftId}/check`, { method: "POST", signal: ctl.signal });
      const started = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(started.error ?? "Could not start the check.");

      const began = Date.now();
      while (!ctl.signal.aborted) {
        // Brisk at first; a check parked on quota is not worth hammering.
        await wait(Date.now() - began < 60_000 ? 1500 : 5000, ctl.signal);
        const poll = await fetch(`/api/drafts/${draftId}/check`, {
          cache: "no-store",
          signal: ctl.signal,
        });
        const data = (await poll.json().catch(() => ({}))) as {
          running?: boolean;
          report?: Report | null;
          error?: string;
        };
        if (!poll.ok) throw new Error(data.error ?? "Lost track of the check.");
        if (data.running) continue;
        if (idRef.current === draftId) setReport(data.report ?? null);
        break;
      }
    } catch (err) {
      if (!ctl.signal.aborted && idRef.current === draftId) {
        setCheckError((err as Error).message);
      }
    } finally {
      if (checkAbort.current === ctl) {
        checkAbort.current = null;
        setChecking(false);
      }
    }
  };

  // Leaving the page should not leave a poll running against it.
  useEffect(() => () => checkAbort.current?.abort(), []);

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

      {citeOpen && (
        <CiteDialog
          onCancel={() => {
            caret.current = null;
            setCiteOpen(false);
          }}
          onAdd={(ref) => void cite(ref)}
        />
      )}
      {libraryOpen && (
        <LibraryCite
          onClose={() => {
            caret.current = null;
            setLibraryOpen(false);
          }}
          onCite={citeFromLibrary}
          onKeep={keepPassage}
        />
      )}

      {paneError && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {paneError}
        </p>
      )}

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
                {saved === "saving"
                  ? " · saving…"
                  : saved === "saved"
                    ? " · saved"
                    : saved === "failed"
                      ? " · not saved"
                      : ""}
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
              onCite={() => {
                rememberCaret();
                setCiteOpen(true);
              }}
              onLibrary={() => {
                rememberCaret();
                setLibraryOpen(true);
              }}
              dir={dirOf(stripTags(body)) as "ltr" | "rtl"}
            />

            {/* Under the text, where you look when you are writing to a length.
                There was a count beside the title, in grey, sharing a line with
                the save state and a Delete button — which is where a number
                goes to be missed. */}
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-[var(--color-rule)] pt-2 text-sm tabular-nums">
              <span className="font-medium">
                {countWords(body).toLocaleString()} <span className="font-normal">words</span>
              </span>
              <span className="text-[var(--color-muted)]">
                {countCharacters(body).toLocaleString()} characters
              </span>
              <span className="text-[var(--color-muted)]">{readingTime(countWords(body))} to read</span>
              {refs.length > 0 ? (
                <span className="text-[var(--color-muted)]">
                  {refs.length} citation{refs.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>

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
                        aria-label={`Remove reference ${i + 1}`}
                        title="Remove this reference and its markers from the text"
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

                {/* ---- a quote you have in front of you ---- */}
                {!logOpen ? (
                  <button
                    type="button"
                    onClick={() => void openLog()}
                    disabled={id === null}
                    className="w-full rounded-lg border border-dashed border-[var(--color-rule)] px-3 py-2 text-left text-sm text-[var(--color-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] disabled:opacity-40"
                    title="Paste a quote and tie it to a citation"
                  >
                    + Log a quote or a source
                  </button>
                ) : (
                  <div className="space-y-2 rounded-lg border border-[var(--color-accent)]/50 bg-white p-3">
                    <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">
                      Log a quote
                    </h3>
                    <textarea
                      autoFocus
                      value={logText}
                      onChange={(e) => setLogText(e.target.value)}
                      rows={4}
                      placeholder="Paste the quote…"
                      dir={dirOf(logText)}
                      className="w-full rounded border border-[var(--color-rule)] p-2 text-sm outline-none focus:border-[var(--color-accent)]"
                    />
                    <div className="space-y-1">
                      <label className="block text-[0.7rem] text-[var(--color-muted)]">
                        Tie it to a source in the library
                      </label>
                      {logSource ? (
                        <p className="flex items-center gap-2 text-xs">
                          <span className="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5">{truncate(logSource.title, 60)}</span>
                          <button
                            type="button"
                            className="text-[var(--color-muted)] hover:underline"
                            onClick={() => {
                              setLogSource(null);
                              setLogCite("");
                            }}
                          >
                            change
                          </button>
                        </p>
                      ) : (
                        <>
                          <input
                            value={sourceQ}
                            onChange={(e) => setSourceQ(e.target.value)}
                            placeholder={library === null ? "Loading the library…" : "Type part of a title or author…"}
                            className="w-full rounded border border-[var(--color-rule)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
                          />
                          {sourceQ.trim().length >= 2 && library ? (
                            <ul className="max-h-36 divide-y divide-[var(--color-rule)] overflow-y-auto rounded border border-[var(--color-rule)] text-xs">
                              {library
                                .filter((s) => `${s.title} ${s.author ?? ""} ${s.outlet ?? ""}`.toLowerCase().includes(sourceQ.trim().toLowerCase()))
                                .slice(0, 8)
                                .map((s) => (
                                  <li key={s.id}>
                                    <button
                                      type="button"
                                      onClick={() => pickSource(s)}
                                      className="block w-full px-2 py-1 text-left hover:bg-[var(--color-accent-soft)]/50"
                                    >
                                      <span className="block truncate">{s.title}</span>
                                      <span className="block text-[var(--color-muted)]">
                                        {[s.author, s.outlet, s.year].filter(Boolean).join(" · ")}
                                      </span>
                                    </button>
                                  </li>
                                ))}
                            </ul>
                          ) : null}
                        </>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[0.7rem] text-[var(--color-muted)]">
                        {logSource ? "Citation, as it will read" : "Or type the citation — a book read elsewhere, a page, a broadcast"}
                      </label>
                      <input
                        value={logCite}
                        onChange={(e) => setLogCite(e.target.value)}
                        placeholder="Author, Title, Year, page"
                        className="w-full rounded border border-[var(--color-rule)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
                      />
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <button
                        type="button"
                        disabled={!logText.trim()}
                        onClick={() => void logQuote()}
                        className="rounded-full bg-[var(--color-accent)] px-3 py-1 text-white disabled:opacity-30"
                      >
                        Put it on the shelf
                      </button>
                      <button
                        type="button"
                        className="text-[var(--color-muted)] hover:underline"
                        onClick={() => {
                          setLogOpen(false);
                          setLogText("");
                          setLogCite("");
                          setLogSource(null);
                        }}
                      >
                        Cancel
                      </button>
                      <span className="ml-auto text-[var(--color-muted)]">
                        {logText.trim() ? `${logText.trim().split(/\s+/).length} words` : ""}
                      </span>
                    </div>
                  </div>
                )}

                {notes.length > 0 && (
                  <div className="rounded-lg border border-[var(--color-rule)] bg-white p-3">
                    <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">
                      Gathered
                    </h3>
                    <ul className="space-y-2">
                      {notes.map((n) => (
                        <li key={n.id} className="rounded border border-[var(--color-rule)] p-2 text-sm">
                          <Quote text={n.text} limit={180} />
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
                            {n.citation && (
                              <button
                                className="text-[var(--color-muted)] hover:underline"
                                title="Add this to your references and cite it where the cursor is"
                                onClick={() =>
                                  void cite({
                                    origin: n.source_id ? "library" : "outside",
                                    text: n.citation ?? "",
                                    quote: n.text,
                                    sourceId: n.source_id ?? undefined,
                                  })
                                }
                              >
                                Cite
                              </button>
                            )}
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
                        <Quote text={h.quote} limit={240} />
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

                {checkError && (
                  <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                    {checkError}
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
                      {report.checkedAt && (
                        <span title={formatDateTime(report.checkedAt)}>
                          {" "}· checked {relativeDate(report.checkedAt)}
                        </span>
                      )}
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

/**
 * A quote on the shelf, shortened to a few lines with the rest one click
 * away. It used to be cut at the limit with no way back to the whole — and
 * the whole is what you gathered it for.
 */
function Quote({ text, limit }: { text: string; limit: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > limit;
  return (
    <div>
      <p className="whitespace-pre-wrap italic" dir={dirOf(text)}>
        “{open || !long ? text : truncate(text, limit)}”
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)] hover:underline"
        >
          {open ? "Show less" : `Show all (${text.split(/\s+/).filter(Boolean).length} words)`}
        </button>
      )}
    </div>
  );
}

/** The editor stores HTML; direction and word counts want the words. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

/** A pause that a cancelled check can cut short. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function countWords(s: string): number {
  const t = stripTags(s).trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Characters as a sub-editor counts them: the text, spaces included. */
function countCharacters(s: string): number {
  return stripTags(s).trim().length;
}

/** At 230 words a minute, which is a reading pace rather than a speaking one. */
function readingTime(words: number): string {
  if (words < 115) return "under a minute";
  const minutes = Math.round(words / 230);
  return `${minutes} min`;
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
    <Modal label="Add a reference" onClose={onCancel}>
        <h3 className="font-serif text-lg font-semibold">Add a reference</h3>
        <p className="mt-0.5 text-xs text-[var(--color-muted)]">
          For something not in your library. To cite your own sources, use <em>Cite from library</em> in
          the toolbar, or <em>Cite</em> beside a search result.
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
    </Modal>
  );
}
